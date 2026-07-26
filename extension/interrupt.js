import { getConfig, appendLog, getTodayStats } from "./storage.js";
import { PAUSE_SECONDS } from "./constants.js";

// answers map: question.id -> string (text) | true | false (bool)
const answers = {};

// Set after countdown completes
let countdownDone = false;

// Questions currently visible, recomputed by syncQuestions() after every
// answer (a bool question's "If No" branching can reveal or hide later ones).
let currentActive = [];

// Maps question id -> its wrapper element, for incremental add/remove.
const renderedElements = new Map();

// Hostname of the destination URL, computed once in DOMContentLoaded
// (file:// URLs have none). Used to decide whether "skip this site" makes
// sense, and as part of the ALLOW_TEMP message.
let hostname = "";

// A single showIf condition: either "that question was answered Yes/No"
// (bool triggers) or "that question has been given any answer at all"
// (non-bool triggers, which have no particular value to branch on).
function conditionMet(cond) {
  if (cond.answered) return answers[cond.questionId] !== undefined;
  return answers[cond.questionId] === cond.equals;
}

// Walks the question list; a question with "showIf" (set in Settings) only
// appears once at least one of its trigger conditions is met — this OR
// semantics is what lets two different branches converge on the same later
// question.
function computeActiveQuestions(questions) {
  const active = [];
  for (const q of questions) {
    if (q.showIf?.length > 0 && !q.showIf.some(conditionMet)) continue;
    active.push(q);
  }
  return active;
}

// Returns the minute value from the active "duration" question linked to
// `target` ("tab" or "domain") via tempAllowTarget, or null if no such
// question is currently active/answered.
function getTempAllowMinutes(target) {
  const q = currentActive.find((q) => q.type === "duration" && q.tempAllowTarget === target);
  if (!q) return null;
  const minutes = parseInt(answers[q.id], 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

// Re-evaluate whether Continue (and any temp-allow buttons) should be
// enabled/visible. Requires: countdown finished AND every visible question
// has an answer. Temp-allow buttons only appear when a linked "duration"
// question is currently active and answered.
function checkEnableButton() {
  if (!countdownDone) return;
  const allAnswered = currentActive.every((q) => answers[q.id] !== undefined);
  document.getElementById("continue-btn").disabled = !allAnswered;

  const tabMinutes = getTempAllowMinutes("tab");
  const domainMinutes = getTempAllowMinutes("domain");

  const tabBtn = document.getElementById("temp-tab-btn");
  const domainBtn = document.getElementById("temp-domain-btn");

  if (tabMinutes !== null) {
    tabBtn.textContent = `Skip this tab for ${tabMinutes} min`;
    tabBtn.style.display = "";
    tabBtn.disabled = !allAnswered;
  } else {
    tabBtn.style.display = "none";
  }

  // Domain skips don't apply to file:// destinations (no hostname to match).
  if (domainMinutes !== null && hostname) {
    domainBtn.textContent = `Skip this site for ${domainMinutes} min`;
    domainBtn.style.display = "";
    domainBtn.disabled = !allAnswered;
  } else {
    domainBtn.style.display = "none";
  }

  document.getElementById("temp-allow-section").style.display =
    tabBtn.style.display !== "none" || domainBtn.style.display !== "none" ? "" : "none";
}

// Recomputes the visible question set and adds/removes question elements to
// match. Called after every answer change.
function syncQuestions(questions) {
  const form = document.getElementById("question-form");
  currentActive = computeActiveQuestions(questions);
  const activeIds = new Set(currentActive.map((q) => q.id));

  for (const [id, el] of [...renderedElements]) {
    if (!activeIds.has(id)) {
      el.remove();
      renderedElements.delete(id);
      delete answers[id];
    }
  }

  // Create elements for newly-revealed questions first (without touching the
  // DOM position of anything already rendered).
  for (const q of currentActive) {
    if (!renderedElements.has(q.id)) {
      let el;
      if (q.type === "bool") el = renderBoolQuestion(q, questions);
      else if (q.type === "duration") el = renderDurationQuestion(q, questions);
      else el = renderTextQuestion(q, questions);
      renderedElements.set(q.id, el);
    }
  }

  // Move only the elements that are actually out of place, instead of
  // re-appending everything whenever the active set changes size (e.g. the
  // question just answered reveals a new one). Re-appending an element
  // that's already in the DOM — even to the same effective position —
  // steals focus from a textarea the user is typing into; walking forward
  // and only touching a slot when it doesn't already hold the right
  // element leaves every untouched (possibly focused) element alone.
  const desired = currentActive.map((q) => renderedElements.get(q.id));
  desired.forEach((el, i) => {
    if (form.children[i] !== el) {
      form.insertBefore(el, form.children[i] ?? null);
    }
  });

  checkEnableButton();
}

// Render one bool question as two toggle buttons (Yes / No). Returns the
// wrapper element (not yet attached to the form).
function renderBoolQuestion(q, questions) {
  const wrapper = document.createElement("div");
  wrapper.className = "question";

  const label = document.createElement("span");
  label.className = "question-text";
  label.textContent = q.text;
  wrapper.appendChild(label);

  const group = document.createElement("div");
  group.className = "bool-group";

  ["Yes", "No"].forEach((optionText) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bool-btn";
    btn.textContent = optionText;
    btn.dataset.value = optionText === "Yes" ? "true" : "false";

    btn.addEventListener("click", () => {
      // Deselect sibling, select self
      group.querySelectorAll(".bool-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      answers[q.id] = optionText === "Yes";
      syncQuestions(questions);
    });

    group.appendChild(btn);
  });

  wrapper.appendChild(group);
  return wrapper;
}

// Render one text question as a textarea. Returns the wrapper element (not
// yet attached to the form).
function renderTextQuestion(q, questions) {
  const wrapper = document.createElement("div");
  wrapper.className = "question";

  const labelEl = document.createElement("label");
  labelEl.className = "question-text";
  labelEl.textContent = q.text;

  const textarea = document.createElement("textarea");
  textarea.rows = 2;

  textarea.addEventListener("input", () => {
    const val = textarea.value.trim();
    // Store undefined when empty so checkEnableButton treats it as unanswered
    answers[q.id] = val.length > 0 ? val : undefined;
    syncQuestions(questions);
  });

  wrapper.appendChild(labelEl);
  wrapper.appendChild(textarea);
  return wrapper;
}

// Render one "duration" question as a number input (minutes). These are
// follow-ups revealed by a trigger question's showIf, and feed a temp-allow
// button via tempAllowTarget. Returns the wrapper element (not yet attached).
function renderDurationQuestion(q, questions) {
  const wrapper = document.createElement("div");
  wrapper.className = "question";

  const labelEl = document.createElement("label");
  labelEl.className = "question-text";
  labelEl.textContent = q.text;

  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.value = q.defaultMinutes ?? 30;

  // Pre-fill an answer from the default so this question doesn't block
  // Continue until the user changes it.
  answers[q.id] = String(input.value);

  input.addEventListener("input", () => {
    const minutes = parseInt(input.value, 10);
    answers[q.id] = Number.isFinite(minutes) && minutes > 0 ? String(minutes) : undefined;
    syncQuestions(questions);
  });

  wrapper.appendChild(labelEl);
  wrapper.appendChild(input);
  return wrapper;
}

// Tick down every second. When it hits 0, clear the interval and check
// whether all answers are in so we can unlock the Continue button.
function startCountdown() {
  const countdownEl = document.getElementById("countdown");
  const btn = document.getElementById("continue-btn");
  let remaining = PAUSE_SECONDS;

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      countdownDone = true;
      btn.textContent = "Continue";
      checkEnableButton();
    } else {
      countdownEl.textContent = remaining;
    }
  }, 1000);
}

document.addEventListener("DOMContentLoaded", async () => {
  // The destination is carried in the URL fragment (see rules.js) so that
  // "?", "&", "+", and spaces in the destination survive intact.
  const rawDest = location.hash.slice(1); // drop leading "#"
  let dest = "";
  try {
    dest = rawDest ? decodeURIComponent(rawDest) : "";
  } catch {
    dest = rawDest; // fall back to the raw value if it isn't valid percent-encoding
  }

  document.getElementById("dest-url").textContent = dest || "(no destination captured)";

  if (!dest) return;

  const config = await getConfig();
  let { questions } = config;

  // file:// URLs have no hostname, so "skip this site" doesn't apply to them.
  try { hostname = new URL(dest).hostname; } catch { /* leave empty */ }

  // Master switch: if disabled, timer follow-up questions (and the
  // temp-allow buttons they reveal) are excluded entirely.
  if (config.allowTimerFollowups === false) {
    questions = questions.filter((q) => q.type !== "duration");
  }

  // Populate today's stats bar
  const stats = await getTodayStats();
  const statsBar = document.getElementById("stats-bar");
  if (stats.total === 0) {
    statsBar.textContent = "First redirect today.";
  } else {
    const pctText = stats.pct !== null ? ` · ${stats.pct}% on track` : "";
    statsBar.textContent = `${stats.total} redirect${stats.total === 1 ? "" : "s"} today${pctText}`;
  }

  // Wire up the View log and Settings links
  document.getElementById("log-link").href = chrome.runtime.getURL("log.html");
  document.getElementById("settings-link").href = chrome.runtime.getURL("settings.html");

  syncQuestions(questions);
  startCountdown();

  // Builds a log record for the current answers. grantScope describes which
  // kind of allowance the user chose (e.g. "tab-once", "tab-30m", "domain-30m").
  function buildRecord(grantScope) {
    // Compute onTrack from visible questions flagged as isOnTrackGate.
    // A gate question skipped via branching doesn't count — only gates the
    // user actually saw apply. If none were shown, onTrack is null (not measured).
    const gateQuestions = currentActive.filter((q) => q.isOnTrackGate && q.type === "bool");
    const onTrack = gateQuestions.length === 0
      ? null
      : gateQuestions.every((q) => answers[q.id] === true);

    const activeIds = new Set(currentActive.map((q) => q.id));

    return {
      version: 1,
      timestamp: Date.now(),
      destinationUrl: dest,
      whitelistId: config.activeWhitelistId,
      // Snapshot every configured question, marking which ones the user
      // actually saw (the rest were skipped by "If No" branching).
      questions: config.questions.map(({ id, text, shortLabel, type }) => ({ id, text, shortLabel, type, seen: activeIds.has(id) })),
      answers: { ...answers },
      category: onTrack ? "on-track" : "rabbit-hole",
      onTrack,
      grantScope,
    };
  }

  document.getElementById("continue-btn").addEventListener("click", async () => {
    await appendLog(buildRecord("tab-once"));

    // Ask the service worker to register a one-time allow rule for this tab,
    // then navigate only after the rule is confirmed — prevents a redirect loop.
    const tab = await chrome.tabs.getCurrent();
    chrome.runtime.sendMessage({ type: "ALLOW_ONCE", tabId: tab.id }, (response) => {
      if (response?.ok) {
        location.href = dest;
      } else {
        console.error("ALLOW_ONCE failed, not navigating.");
      }
    });
  });

  // Grants a temporary allowance (scope "tab" or "domain") for N minutes,
  // then navigates once the service worker confirms the grant is in place.
  // The minute count comes from the active "duration" question linked to
  // this scope via tempAllowTarget.
  async function handleTempAllow(scope) {
    const minutes = getTempAllowMinutes(scope);
    if (minutes === null) return;

    await appendLog(buildRecord(`${scope}-${minutes}m`));

    const tab = await chrome.tabs.getCurrent();
    chrome.runtime.sendMessage(
      { type: "ALLOW_TEMP", scope, tabId: tab.id, hostname, minutes },
      (response) => {
        if (response?.ok) {
          location.href = dest;
        } else {
          console.error("ALLOW_TEMP failed, not navigating.");
        }
      }
    );
  }

  document.getElementById("temp-tab-btn").addEventListener("click", () => handleTempAllow("tab"));
  document.getElementById("temp-domain-btn").addEventListener("click", () => handleTempAllow("domain"));
});
