import { buildBlockingRules, registerAllowOnce, registerTempAllow, removeSessionRule } from "./rules.js";
import { DEFAULT_CONFIG } from "./storage.js";
import { HISTORY_GRACE_MS } from "./constants.js";

// Returns true if the URL matches any always-allowed entry.
// scope "domain": pattern "example.com" covers example.com and all subdomains.
// scope "file-prefix": pattern is a file:// path prefix (file:// URLs have no
// hostname, so domain matching can't apply to them).
function isAlwaysAllowed(url, alwaysAllowed) {
  return alwaysAllowed.some(({ pattern, scope }) => {
    if (scope === "file-prefix") return url.startsWith(pattern);
    let hostname;
    try { hostname = new URL(url).hostname.toLowerCase(); }
    catch { return false; }
    const p = pattern.toLowerCase();
    return hostname === p || hostname.endsWith(`.${p}`);
  });
}

// Returns true if a temporary-allow grant (see ALLOW_TEMP below) currently
// covers this URL/tab. Expired entries (alarm not yet fired) are ignored.
async function isTempAllowed(url, tabId) {
  const { tempAllowed = [] } = await chrome.storage.session.get("tempAllowed");
  const now = Date.now();
  let hostname;
  try { hostname = new URL(url).hostname.toLowerCase(); }
  catch { hostname = ""; }

  return tempAllowed.some((entry) => {
    if (entry.expiresAt <= now) return false;
    if (entry.scope === "tab") return entry.tabId === tabId;
    const p = entry.hostname.toLowerCase();
    return hostname === p || hostname.endsWith(`.${p}`);
  });
}

// Reads the active whitelist from cfg and installs fresh dynamic rules.
// Called on install/update and whenever the user saves new settings.
function registerDynamicRules(cfg) {
  const activeList = cfg.whitelists[cfg.activeWhitelistId];
  const rules = buildBlockingRules(chrome.runtime.id, activeList.alwaysAllowed);

  chrome.declarativeNetRequest.getDynamicRules((existing) => {
    chrome.declarativeNetRequest.updateDynamicRules(
      { removeRuleIds: existing.map((r) => r.id), addRules: rules },
      () => {
        if (chrome.runtime.lastError) {
          console.error("Failed to register rules:", chrome.runtime.lastError.message);
        }
      }
    );
  });
}

// Clear this tab's allow-once rule (if any) once a main-frame navigation in
// it commits — i.e. after any server-side redirect chain has finished. This
// ensures the grant is consumed exactly once and cannot be reused on a
// subsequent visit to the same site.
//
// Also stamp the tab's focus timestamp here: landing on a page counts as
// "using this tab now", so switching away and back within the configured
// focus timeout won't re-trigger the tab-focus interrupt.
//
// And stamp a short history-state grace window (see onHistoryStateUpdated
// below): a real navigation just landed here, so an immediate same-document
// URL change right after is most likely the page normalizing its own URL,
// not a new destination the user actually navigated to.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only

  const now = Date.now();
  chrome.storage.session.set({
    [`tab_focus_${details.tabId}`]: now,
    [`tab_nav_grace_${details.tabId}`]: now + HISTORY_GRACE_MS,
  });

  chrome.declarativeNetRequest.getSessionRules((rules) => {
    // Priority 3 = allow-once grants (consumed by this navigation).
    // Priority 2 = temporary tab/domain allowances, which must survive
    // navigation and are instead removed by their chrome.alarms timer.
    const toRemove = rules
      .filter((r) => r.priority === 3 && r.condition.tabIds?.includes(details.tabId))
      .map((r) => r.id);
    if (toRemove.length > 0) {
      chrome.declarativeNetRequest.updateSessionRules(
        { removeRuleIds: toRemove }, () => {}
      );
    }
  });
});

// SPA sites (YouTube, Wolfram Alpha, etc.) change the URL via the History
// API (pushState/replaceState) when you click a new video or submit a new
// query, rather than a real navigation — so the declarativeNetRequest rules
// above, which only see actual main_frame network requests, never see it
// and can't redirect it. This is the dedicated event for that case: it
// fires on same-document URL changes, so we redirect the tab ourselves.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only

  const { url, tabId } = details;
  if (!url?.startsWith("http")) return;

  const graceKey = `tab_nav_grace_${tabId}`;
  const stored = await chrome.storage.session.get(graceKey);
  if (Date.now() < (stored[graceKey] ?? 0)) return; // right after a real navigation — likely the page's own URL normalization

  const { config } = await chrome.storage.local.get("config");
  const cfg = config ?? DEFAULT_CONFIG;
  const activeList = cfg.whitelists[cfg.activeWhitelistId];

  if (isAlwaysAllowed(url, activeList.alwaysAllowed)) return;
  if (await isTempAllowed(url, tabId)) return;

  chrome.tabs.update(tabId, {
    url: `chrome-extension://${chrome.runtime.id}/interrupt.html#${encodeURIComponent(url)}`,
  });
});

chrome.runtime.onInstalled.addListener(() => {
  // Session rules survive extension reloads (only cleared on browser restart).
  // Wipe them on every install/update so stale allow-once rules can't carry over.
  chrome.declarativeNetRequest.getSessionRules((existing) => {
    if (existing.length > 0) {
      chrome.declarativeNetRequest.updateSessionRules(
        { removeRuleIds: existing.map((r) => r.id) }, () => {}
      );
    }
  });

  // Seed config on first install, then register blocking rules from it.
  // Using the stored config (not the hardcoded default) means user edits
  // survive extension updates.
  chrome.storage.local.get("config", ({ config }) => {
    const cfg = config ?? DEFAULT_CONFIG;
    if (!config) chrome.storage.local.set({ config: DEFAULT_CONFIG });
    registerDynamicRules(cfg);
  });
});

// Re-register rules automatically whenever the user saves settings —
// no manual extension reload required.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config?.newValue) {
    registerDynamicRules(changes.config.newValue);
  }
});

// When the user switches to a tab that hasn't been focused in cfg.focusTimeoutMinutes,
// redirect it to the interrupt page — even though no navigation is happening.
// This catches tabs left open and forgotten rather than actively navigated to.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { return; } // tab may have closed between the event and the get

  const { url } = tab;
  if (!url?.startsWith("http")) return; // skip extension pages, chrome://, etc.

  const { config } = await chrome.storage.local.get("config");
  const cfg = config ?? DEFAULT_CONFIG;
  const activeList = cfg.whitelists[cfg.activeWhitelistId];

  if (isAlwaysAllowed(url, activeList.alwaysAllowed)) return;
  if (await isTempAllowed(url, tabId)) return;

  const focusTimeoutMs = (cfg.focusTimeoutMinutes ?? DEFAULT_CONFIG.focusTimeoutMinutes) * 60 * 1000;

  const focusKey = `tab_focus_${tabId}`;
  const stored = await chrome.storage.session.get(focusKey);
  const lastFocus = stored[focusKey] ?? 0;
  const now = Date.now();

  if (now - lastFocus < focusTimeoutMs) {
    // Recently used — just refresh the "last looked at" timestamp.
    await chrome.storage.session.set({ [focusKey]: now });
    return;
  }

  // Stale tab: try to redirect to the interrupt page. Deliberately not
  // stamping the timestamp here — if the page has its own unload
  // confirmation (e.g. Desmos warning about unsaved work) and the user
  // declines to leave, this navigation never actually lands, and we don't
  // want to have already marked the interrupt as "seen" in that case. The
  // onCommitted listener above stamps the timestamp for us once (if) a
  // navigation actually commits here, so a declined redirect correctly
  // leaves the tab stale — the very next switch away and back retries it.
  chrome.tabs.update(tabId, {
    url: `chrome-extension://${chrome.runtime.id}/interrupt.html#${encodeURIComponent(url)}`,
  });
});

// Clean up per-tab focus timestamps when a tab is closed, along with any
// tab-scoped temporary-allow grant (a domain-scoped grant stays active for
// other tabs, so it's left alone).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  chrome.storage.session.remove([`tab_focus_${tabId}`, `tab_nav_grace_${tabId}`]);

  const { tempAllowed = [] } = await chrome.storage.session.get("tempAllowed");
  const toRemove = tempAllowed.filter((e) => e.scope === "tab" && e.tabId === tabId);
  if (toRemove.length === 0) return;

  await chrome.storage.session.set({
    tempAllowed: tempAllowed.filter((e) => !(e.scope === "tab" && e.tabId === tabId)),
  });
  for (const entry of toRemove) {
    await removeSessionRule(entry.ruleId);
    chrome.alarms.clear(`tempAllow_${entry.ruleId}`);
  }
});

// Message handler: interrupt page sends ALLOW_ONCE or ALLOW_TEMP before navigating.
// Return true to keep the message channel open for the async response.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ALLOW_ONCE" && typeof message.tabId === "number") {
    registerAllowOnce(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("registerAllowOnce failed:", err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === "ALLOW_TEMP" && typeof message.tabId === "number") {
    const { scope, hostname, minutes } = message;
    (async () => {
      try {
        const ruleId = await registerTempAllow({ scope, hostname, tabId: message.tabId });
        const expiresAt = Date.now() + minutes * 60 * 1000;

        const { tempAllowed = [] } = await chrome.storage.session.get("tempAllowed");
        tempAllowed.push({ ruleId, scope, hostname, tabId: message.tabId, expiresAt });
        await chrome.storage.session.set({ tempAllowed });

        chrome.alarms.create(`tempAllow_${ruleId}`, { when: expiresAt });
        sendResponse({ ok: true });
      } catch (err) {
        console.error("registerTempAllow failed:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// When a temporary-allow grant's timer fires, remove its session rule and
// drop it from storage. chrome.alarms persists across service worker sleep,
// so this fires reliably even if the worker was asleep when it was due.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("tempAllow_")) return;
  const ruleId = Number(alarm.name.slice("tempAllow_".length));

  await removeSessionRule(ruleId);

  const { tempAllowed = [] } = await chrome.storage.session.get("tempAllowed");
  await chrome.storage.session.set({
    tempAllowed: tempAllowed.filter((e) => e.ruleId !== ruleId),
  });
});
