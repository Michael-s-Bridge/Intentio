// Lowest session rule ID. Kept above dynamic rule IDs (1–99) so the two
// rule sets never collide.
const SESSION_RULE_MIN_ID = 1000;

// Picks an ID higher than any existing session rule, so a fresh ID is always
// safe even after the service worker restarts (module-level counters reset,
// but existing rules don't).
function nextSessionRuleId(existing) {
  let max = SESSION_RULE_MIN_ID - 1;
  for (const r of existing) if (r.id > max) max = r.id;
  return max + 1;
}

// alwaysAllowed: array of { pattern, scope } objects from the active whitelist in config.
// scope "domain"      -> pattern is a hostname; matches it and all subdomains (||pattern).
// scope "file-prefix" -> pattern is a file:// URL/folder path; matches anything starting
//                        with it (|pattern). file:// URLs have no hostname, so the
//                        domain-anchor syntax can't apply to them.
export function buildBlockingRules(extensionId, alwaysAllowed) {
  const domainAllowRules = alwaysAllowed.map((entry, index) => ({
    id: 10 + index,
    priority: 2,
    action: { type: "allow" },
    condition: {
      urlFilter: entry.scope === "file-prefix" ? `|${entry.pattern}` : `||${entry.pattern}`,
      resourceTypes: ["main_frame"],
    },
  }));

  const catchAllRedirectRule = {
    id: 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        // Carry the destination in the URL fragment (#), not a query
        // parameter. A query parameter gets parsed by URLSearchParams,
        // which mangles destinations that contain their own "?", "&", "+",
        // or spaces (e.g. search URLs or file paths with spaces) — "&"
        // truncates the captured value and "+" turns into a space. A
        // fragment is carried through as a single opaque string.
        regexSubstitution: `chrome-extension://${extensionId}/interrupt.html#\\0`,
      },
    },
    condition: {
      regexFilter: ".*",
      resourceTypes: ["main_frame"],
    },
  };

  return [catchAllRedirectRule, ...domainAllowRules];
}

// Allows every main-frame navigation in this tab through, for exactly one
// navigation — including any server-side redirect chain it triggers.
// Scoping by tabId rather than matching the destination URL means this works
// regardless of how the URL is encoded or how many redirects occur in between.
// Consumed by the webNavigation.onCommitted listener in service-worker.js,
// which removes this tab's rule once that navigation finishes.
export function registerAllowOnce(tabId) {
  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getSessionRules((existing) => {
      // Remove any stale allow-once rule for this tab (shouldn't normally
      // exist, but avoids accumulation if a previous grant was never
      // consumed). Priority 3 distinguishes allow-once rules from
      // longer-lived temporary-allow rules (priority 2, see below), which
      // must NOT be cleared here.
      const removeIds = existing
        .filter((r) => r.priority === 3 && r.condition.tabIds?.includes(tabId))
        .map((r) => r.id);

      const rule = {
        id: nextSessionRuleId(existing),
        priority: 3,
        action: { type: "allow" },
        condition: {
          tabIds: [tabId],
          resourceTypes: ["main_frame"],
        },
      };

      chrome.declarativeNetRequest.updateSessionRules(
        { removeRuleIds: removeIds, addRules: [rule] },
        () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        }
      );
    });
  });
}

// Allows navigations through for a limited time, without re-prompting.
// scope "domain" -> matches the given hostname (and subdomains) in any tab,
//                    via the same ||hostname domain-anchor as the whitelist.
// scope "tab"     -> matches only the given tab, regardless of destination.
// Returns the new rule's ID so the caller can remove it once the grant expires
// (see the chrome.alarms-based cleanup in service-worker.js).
export function registerTempAllow({ scope, hostname, tabId }) {
  const condition = { resourceTypes: ["main_frame"] };
  if (scope === "domain") {
    condition.urlFilter = `||${hostname}`;
  } else {
    condition.tabIds = [tabId];
  }

  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getSessionRules((existing) => {
      const rule = {
        id: nextSessionRuleId(existing),
        priority: 2,
        action: { type: "allow" },
        condition,
      };
      chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(rule.id);
        }
      });
    });
  });
}

// Allows every main-frame navigation through, everywhere, until the pause
// ends — used by the Settings page's "Pause Intentio" button. Priority 4 is
// above every other rule (allow-once is 3, temp-allow/whitelist entries are
// 2, the catch-all block is 1), so it overrides all of them while active.
export function registerPauseAllow() {
  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.getSessionRules((existing) => {
      const rule = {
        id: nextSessionRuleId(existing),
        priority: 4,
        action: { type: "allow" },
        condition: { resourceTypes: ["main_frame"] },
      };
      chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(rule.id);
        }
      });
    });
  });
}

// Removes a single session rule by ID (used when a temporary-allow grant expires).
export function removeSessionRule(id) {
  return new Promise((resolve) => {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }, () => resolve());
  });
}
