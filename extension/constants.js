export const ALWAYS_ALLOWED_DOMAINS = [
  "google.com",
  "microsoft.com",
  "github.com",
];

export const PAUSE_SECONDS = 3;

// Some SPAs call history.replaceState once right after a real page load
// (e.g. to normalize the URL), which would otherwise look identical to a
// genuine same-document navigation and trigger a spurious second interrupt
// immediately after the user just got past the first one. History-state
// updates within this window of a real navigation are let through instead
// of re-interrupting. Short enough that a genuine quick second navigation
// (e.g. clicking straight to another video) is very rarely missed.
export const HISTORY_GRACE_MS = 2000;
