export const DEFAULT_CONFIG = {
  version: 1,
  activeWhitelistId: "default",
  allowTimerFollowups: true,
  // How long a tab can sit idle before switching back to it re-triggers the
  // interrupt. 30 minutes lets you work back-and-forth with a source tab
  // freely within a focused session, while still catching tabs you drifted
  // away from.
  focusTimeoutMinutes: 30,
  whitelists: {
    default: {
      id: "default",
      name: "Default",
      alwaysAllowed: [
        { pattern: "google.com", scope: "domain" },
        { pattern: "microsoft.com", scope: "domain" },
        { pattern: "github.com", scope: "domain" },
      ],
    },
  },
  questions: [
    { id: "goal",     text: "What are you trying to accomplish?",            type: "text" },
    { id: "supposed", text: "Is this something you're supposed to be doing?", type: "bool", isOnTrackGate: true },
    { id: "helps",    text: "Will this help you accomplish your stated goal?", type: "bool", isOnTrackGate: true },
  ],
};

// A question's showIf used to be a single { questionId, equals } condition.
// It's now a list (OR'd together — shown if ANY match), which is what lets
// two different branches converge on the same later question. Normalizes
// old single-object configs into that shape so existing saved data isn't
// silently dropped.
function normalizeConfig(config) {
  return {
    ...config,
    questions: config.questions.map((q) => ({
      ...q,
      showIf: q.showIf ? (Array.isArray(q.showIf) ? q.showIf : [q.showIf]) : undefined,
    })),
  };
}

// Returns the stored config, or DEFAULT_CONFIG if none exists yet.
export function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get("config", ({ config }) => {
      resolve(normalizeConfig(config ?? DEFAULT_CONFIG));
    });
  });
}

// Returns the full log array, or [] if nothing has been stored yet.
export function getLog() {
  return new Promise((resolve) => {
    chrome.storage.local.get("log", ({ log }) => {
      resolve(log ?? []);
    });
  });
}

// Writes the entire config object to storage.
export function saveConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ config }, resolve);
  });
}

// Appends one record to the end of the log array.
export async function appendLog(record) {
  const log = await getLog();
  log.push(record);
  return new Promise((resolve) => {
    chrome.storage.local.set({ log }, resolve);
  });
}

// Clears the entire log.
export function clearLog() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ log: [] }, resolve);
  });
}

// Returns the full pause log (from the Settings page's "Pause Intentio"
// button), or [] if nothing has been stored yet.
export function getPauseLog() {
  return new Promise((resolve) => {
    chrome.storage.local.get("pauseLog", ({ pauseLog }) => {
      resolve(pauseLog ?? []);
    });
  });
}

// Appends one { timestamp, minutes, reason } entry to the pause log.
export async function appendPauseLog(entry) {
  const pauseLog = await getPauseLog();
  pauseLog.push(entry);
  return new Promise((resolve) => {
    chrome.storage.local.set({ pauseLog }, resolve);
  });
}

// Clears the entire pause log.
export function clearPauseLog() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ pauseLog: [] }, resolve);
  });
}

// User-arranged log view state: column order/widths and table (branch group)
// order/collapse. Purely presentational — never affects grouping logic.
export const DEFAULT_LOG_VIEW_PREFS = {
  columnOrder: [],     // column ids in preferred order; unlisted ids fall back to discovery order
  columnWidths: {},    // { [columnId]: widthPx } — only set once a column has been manually resized
  groupOrder: [],      // branch group keys in preferred order
  collapsedGroups: [], // branch group keys currently collapsed
  sortByGroup: {},     // { [groupKey]: { columnId, direction: "asc"|"desc" } }
};

// Returns the stored log view prefs, filled in with defaults for anything missing.
export function getLogViewPrefs() {
  return new Promise((resolve) => {
    chrome.storage.local.get("logViewPrefs", ({ logViewPrefs }) => {
      resolve({ ...DEFAULT_LOG_VIEW_PREFS, ...(logViewPrefs ?? {}) });
    });
  });
}

// Writes the entire log view prefs object to storage.
export function saveLogViewPrefs(prefs) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ logViewPrefs: prefs }, resolve);
  });
}

// Bundles everything a reinstall/transfer needs to restore state: questions,
// always-allowed sites (inside config), the redirect log, how the log view
// is arranged, and the pause log.
export async function exportAllData() {
  const [config, log, logViewPrefs, pauseLog] = await Promise.all([
    getConfig(), getLog(), getLogViewPrefs(), getPauseLog(),
  ]);
  return { config, log, logViewPrefs, pauseLog };
}

// Overwrites config, log, log view prefs, and the pause log with previously
// exported data.
export function importAllData({ config, log, logViewPrefs, pauseLog }) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        config,
        log: log ?? [],
        logViewPrefs: { ...DEFAULT_LOG_VIEW_PREFS, ...(logViewPrefs ?? {}) },
        pauseLog: pauseLog ?? [],
      },
      resolve,
    );
  });
}

// Returns redirect counts for today (midnight-to-now).
export async function getTodayStats() {
  const log = await getLog();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = todayStart.getTime();

  const todayEntries = log.filter((r) => r.timestamp >= since);
  const total = todayEntries.length;
  const measuredEntries = todayEntries.filter((r) => r.onTrack !== null && r.onTrack !== undefined);
  const onTrackCount = measuredEntries.filter((r) => r.onTrack === true).length;
  const pct = measuredEntries.length > 0
    ? Math.round((onTrackCount / measuredEntries.length) * 100)
    : null;

  return { total, onTrackCount, pct };
}
