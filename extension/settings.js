import { getConfig, saveConfig, exportAllData, importAllData, DEFAULT_CONFIG } from "./storage.js";

// In-memory working copy — only written to storage on Save
let workingQuestions = [];
let workingDomains = [];   // array of { pattern, scope } objects

// ── Questions ────────────────────────────────────────────────

// Which Questions tab is showing, and which flowchart node's detail panel
// (if any) is expanded. Purely UI state — not persisted. The flowchart is
// the primary view; List is the secondary/simple one.
let activeQuestionsTab = "tree"; // "list" | "tree"
let selectedTreeNodeId = null;

// Re-renders whichever Questions view is currently visible. Used after any
// change that needs a full rebuild (as opposed to the live label patches
// below, which avoid rebuilding to keep focus in a text input).
function refreshActiveQuestionsView() {
  if (activeQuestionsTab === "tree") renderTree();
  else renderQuestions();
}

// Drops stale showIf conditions — target deleted, would create a cycle (the
// target depends on this question, directly or transitively), or a Yes/No
// condition whose target is no longer a bool question — one at a time,
// since a question can have several (OR'd together; shown if any one
// matches). If every condition turns out stale, showIf itself is cleared.
// Shared by both views since it's a data fixup, not a rendering concern.
function cleanupStaleShowIf() {
  workingQuestions.forEach((q) => {
    if (!q.showIf) return;
    const descendants = collectSubtreeIds(q.id); // includes q.id itself
    const valid = q.showIf.filter((cond) => {
      const target = workingQuestions.find((other) => other.id === cond.questionId);
      if (!target || descendants.has(target.id)) return false;
      return cond.equals === undefined || target.type === "bool";
    });
    q.showIf = valid.length > 0 ? valid : undefined;
  });
}

// Patches the visible label of any "Show only if" checkbox chip that refers
// to question `id`, without a full re-render (which would rebuild the text
// input the user is currently typing in).
function updateReferenceLabels(id, label) {
  const text = label || "(untitled)";
  document.querySelectorAll(`.condition-chip[data-condition-for="${id}"]`).forEach((chip) => {
    const span = chip.querySelector(".condition-chip-label");
    if (!span) return;
    span.textContent = chip.dataset.conditionAnswer === "answered"
      ? `${text} answered`
      : `${text} = ${chip.dataset.conditionAnswer === "yes" ? "Yes" : "No"}`;
  });
}

// Patches the placeholder shown on question `id`'s branch-name inputs (the
// default log table name), without a full re-render.
function updateBranchPlaceholders(id, label) {
  document.querySelectorAll(`[data-branch-id="${id}"][data-branch-suffix="yes"]`).forEach((el) => {
    el.placeholder = `${label} — Yes`;
  });
  document.querySelectorAll(`[data-branch-id="${id}"][data-branch-suffix="no"]`).forEach((el) => {
    el.placeholder = `${label} — No`;
  });
}

// Patches a tree node's box label in place (no rebuild), mirroring the two
// helpers above for the List view.
function updateTreeNodeLabel(id, label) {
  document.querySelectorAll(`.flow-node-wrapper[data-tree-node-id="${id}"] > .flow-node`).forEach((el) => {
    el.textContent = label || "(untitled)";
  });
}

// A small labeled checkbox, used for the per-question "On-track gate" and
// "Split log here" toggles.
function makeBoolToggle(title, labelText, checked, onChange) {
  const label = document.createElement("label");
  label.title = title;
  label.style.cssText = "display:flex; align-items:center; gap:0.3rem; font-size:0.8rem; color:#555; white-space:nowrap; cursor:pointer;";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => onChange(checkbox.checked));

  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(labelText));
  return label;
}

// Every id in q's subtree: q itself, plus every question that depends on it
// (directly or transitively) via any of its showIf conditions. Used to keep
// drag-and-drop from creating a cycle, and to move a reparented question's
// whole subtree together so every member's showIf reference stays valid
// (see moveSubtreeToEnd below).
function collectSubtreeIds(rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const q of workingQuestions) {
      if (q.showIf?.some((cond) => ids.has(cond.questionId)) && !ids.has(q.id)) {
        ids.add(q.id);
        changed = true;
      }
    }
  }
  return ids;
}

// Moves question `id` — and its entire subtree, to keep every member's
// showIf valid — to the end of the array, replacing its showIf with just
// `newCondition` (undefined = always shown). The end is always a valid
// spot, since every subtree member's trigger already exists earlier in the
// array. This is also how "add a question at the end of this branch"
// places a new question, so dragging and adding land new/moved questions
// the same way: last in that branch. Dragging always sets a single
// condition — to make a question converge from more than one branch, check
// additional boxes in its detail panel instead.
function moveSubtreeToEnd(id, newCondition) {
  const subtreeIds = collectSubtreeIds(id);
  const subtree = workingQuestions.filter((q) => subtreeIds.has(q.id));
  const rest = workingQuestions.filter((q) => !subtreeIds.has(q.id));
  subtree.find((q) => q.id === id).showIf = newCondition ? [newCondition] : undefined;
  workingQuestions = [...rest, ...subtree];
}

// Creates a new question with the given single showIf condition (undefined
// = always shown) and selects it in the tree view so its detail panel opens
// right away.
function addQuestionWithShowIf(condition) {
  const newQuestion = { id: `q${Date.now()}`, text: "", type: "text", showIf: condition ? [condition] : undefined };
  workingQuestions.push(newQuestion);
  selectedTreeNodeId = newQuestion.id;
  return newQuestion;
}

function showQuestionsTab(tab) {
  activeQuestionsTab = tab;
  document.getElementById("question-list").style.display = tab === "list" ? "" : "none";
  document.getElementById("tree-view").style.display = tab === "tree" ? "" : "none";
  document.getElementById("tab-list-btn").classList.toggle("active", tab === "list");
  document.getElementById("tab-tree-btn").classList.toggle("active", tab === "tree");
  refreshActiveQuestionsView();
}

document.getElementById("tab-list-btn").addEventListener("click", () => showQuestionsTab("list"));
document.getElementById("tab-tree-btn").addEventListener("click", () => showQuestionsTab("tree"));

// Builds one question's editable row: text, log name, type, gate/split/hide
// toggles, conditional (showIf) dropdown, timer row, branch-name row, and
// delete button. Shared by the List view (one row per question, always
// visible) and the Tree view's detail panel (one at a time, for whichever
// node is selected) — editing behavior is identical either way.
// `showPositionControls` adds the number badge and up/down buttons, which
// only make sense in the List view's flat ordering.
function buildQuestionRow(q, i, { showPositionControls = true } = {}) {
  const row = document.createElement("div");
  row.className = "question-row";

  if (showPositionControls) {
    // Number badge — gives each question a stable, visible label so the
    // "Only if Q_ is answered..." dropdowns can refer to one another.
    const numberBadge = document.createElement("span");
    numberBadge.className = "q-number";
    numberBadge.textContent = String(i + 1);
    row.appendChild(numberBadge);

    const upBtn = document.createElement("button");
    upBtn.className = "reorder-btn";
    upBtn.textContent = "↑";
    upBtn.title = "Move up";
    upBtn.disabled = i === 0;
    upBtn.addEventListener("click", () => {
      [workingQuestions[i - 1], workingQuestions[i]] = [workingQuestions[i], workingQuestions[i - 1]];
      refreshActiveQuestionsView();
    });
    row.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.className = "reorder-btn";
    downBtn.textContent = "↓";
    downBtn.title = "Move down";
    downBtn.disabled = i === workingQuestions.length - 1;
    downBtn.addEventListener("click", () => {
      [workingQuestions[i], workingQuestions[i + 1]] = [workingQuestions[i + 1], workingQuestions[i]];
      refreshActiveQuestionsView();
    });
    row.appendChild(downBtn);
  }

  // Text input
  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.value = q.text;
  textInput.placeholder = "Question text";
  textInput.addEventListener("input", () => {
    workingQuestions[i].text = textInput.value;
    // Other rows' "Show only if" chips, and this question's flowchart node
    // label, show this question's log name (or text) — patch those in
    // place rather than a full rebuild, which would drop focus here.
    const label = logNameInput.value.trim() || textInput.value.trim();
    updateReferenceLabels(q.id, label);
    updateBranchPlaceholders(q.id, label || "(untitled)");
    updateTreeNodeLabel(q.id, label);
  });

  // Log name — short label shown as the log's column header instead of
  // the full question text. Falls back to the question text if left blank.
  const logNameInput = document.createElement("input");
  logNameInput.type = "text";
  logNameInput.className = "log-name-input";
  logNameInput.value = q.shortLabel || "";
  logNameInput.placeholder = "Log name";
  logNameInput.title = "Short column header for the log and tree view (defaults to the question text)";
  logNameInput.addEventListener("input", () => {
    workingQuestions[i].shortLabel = logNameInput.value;
    const label = logNameInput.value.trim() || textInput.value.trim();
    updateReferenceLabels(q.id, label);
    updateBranchPlaceholders(q.id, label || "(untitled)");
    updateTreeNodeLabel(q.id, label);
  });

  // Type selector
  const typeSelect = document.createElement("select");
  typeSelect.title = "Answer type";
  [["text", "Text answer"], ["bool", "Yes / No"], ["duration", "Timer (minutes)"]].forEach(([val, label]) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (val === q.type) opt.selected = true;
    typeSelect.appendChild(opt);
  });
  typeSelect.addEventListener("change", () => {
    workingQuestions[i].type = typeSelect.value;
    if (typeSelect.value !== "bool") {
      workingQuestions[i].isOnTrackGate = false;
      workingQuestions[i].isBranchSplit = false;
    }
    if (typeSelect.value !== "duration") {
      workingQuestions[i].tempAllowTarget = undefined;
    }
    refreshActiveQuestionsView(); // rebuild so the gate/split checkboxes, conditional, and timer rows show/hide correctly
  });

  // Gate checkbox — only meaningful for bool questions
  const gateLabel = makeBoolToggle(
    "If checked, answering Yes is required for a visit to count as on-track",
    "On-track gate",
    !!q.isOnTrackGate,
    (checked) => { workingQuestions[i].isOnTrackGate = checked; },
  );
  gateLabel.style.display = q.type === "bool" ? "flex" : "none";

  // Split checkbox — only meaningful for bool questions. Splits the log
  // into separate tables for Yes vs No answers to this question; multiple
  // split questions combine into one table per combination actually seen.
  const splitLabel = makeBoolToggle(
    "Split the log into separate tables for Yes vs No answers to this question",
    "Split log here",
    !!q.isBranchSplit,
    (checked) => { workingQuestions[i].isBranchSplit = checked; refreshActiveQuestionsView(); },
  );
  splitLabel.style.display = q.type === "bool" ? "flex" : "none";

  // Hide-from-log checkbox — available for every question type. Excludes
  // this question's column from the log view entirely (e.g. when it's
  // redundant with another column, like a skip-timer question next to the
  // Allowance column).
  const hideLabel = makeBoolToggle(
    "Exclude this question's column from the log view entirely",
    "Hide from log",
    !!q.hideFromLog,
    (checked) => { workingQuestions[i].hideFromLog = checked; },
  );

  // Delete button — disabled when only one question remains
  const delBtn = document.createElement("button");
  delBtn.className = "delete-btn";
  delBtn.textContent = "✕";
  delBtn.title = "Delete question";
  delBtn.disabled = workingQuestions.length === 1;
  delBtn.addEventListener("click", () => {
    workingQuestions.splice(i, 1);
    if (selectedTreeNodeId === q.id) selectedTreeNodeId = null;
    refreshActiveQuestionsView();
  });

  row.appendChild(textInput);
  row.appendChild(logNameInput);
  row.appendChild(typeSelect);
  row.appendChild(gateLabel);
  row.appendChild(splitLabel);
  row.appendChild(hideLabel);
  row.appendChild(delBtn);

  // Conditional visibility — available for all question types, shown if
  // ANY checked condition matches (OR'd together). Checking conditions
  // referencing more than one other question is how a question converges —
  // it appears on whichever one gets answered first. Any question can be a
  // trigger, not just Yes/No ones — a text/duration question offers a
  // single "answered" condition instead of Yes/No, since it has no
  // particular value to branch on. The only questions excluded are this one
  // itself and anything that depends on it (which would create a cycle) —
  // not "earlier in the list", so the same set of options is available
  // regardless of where a question happens to sit in List view order.
  const descendantsOfThis = collectSubtreeIds(q.id); // includes q.id itself
  const eligibleQuestions = workingQuestions.filter((other) => !descendantsOfThis.has(other.id));
  if (eligibleQuestions.length > 0) {
    const conditionRow = document.createElement("div");
    conditionRow.className = "config-row condition-row";

    const conditionLabel = document.createElement("span");
    conditionLabel.textContent = "Show only if:";
    conditionLabel.style.cssText = "font-size:0.75rem; color:#888; margin-right:auto; align-self:center;";
    conditionRow.appendChild(conditionLabel);

    // Builds one checkbox chip. `matches(cond)` identifies this specific
    // condition among the question's showIf list; `makeCondition()` builds
    // it fresh when the box is checked.
    const buildChip = (suffix, title, labelText, matches, makeCondition) => {
      const chip = document.createElement("label");
      chip.className = `condition-chip ${suffix}`;
      chip.title = title;
      chip.dataset.conditionFor = makeCondition().questionId;
      chip.dataset.conditionAnswer = suffix;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = (workingQuestions[i].showIf ?? []).some(matches);
      checkbox.addEventListener("change", () => {
        const current = workingQuestions[i].showIf ?? [];
        const without = current.filter((cond) => !matches(cond));
        const next = checkbox.checked ? [...without, makeCondition()] : without;
        workingQuestions[i].showIf = next.length > 0 ? next : undefined;
        refreshActiveQuestionsView(); // refresh connector/indenting/flowchart to reflect the new dependency
      });

      const chipLabel = document.createElement("span");
      chipLabel.className = "condition-chip-label";
      chipLabel.textContent = labelText;

      chip.appendChild(checkbox);
      chip.appendChild(chipLabel);
      return chip;
    };

    eligibleQuestions.forEach((other) => {
      const otherLabel = other.shortLabel?.trim() || other.text?.trim() || "(untitled)";

      if (other.type === "bool") {
        ["yes", "no"].forEach((suffix) => {
          const equals = suffix === "yes";
          conditionRow.appendChild(buildChip(
            suffix,
            `Show this question when "${otherLabel}" is answered ${suffix === "yes" ? "Yes" : "No"}`,
            `${otherLabel} = ${suffix === "yes" ? "Yes" : "No"}`,
            (cond) => cond.questionId === other.id && cond.equals === equals,
            () => ({ questionId: other.id, equals }),
          ));
        });
      } else {
        // Non-Yes/No questions have no particular value to branch on, so
        // the only condition offered is "this has been answered at all".
        conditionRow.appendChild(buildChip(
          "answered",
          `Show this question once "${otherLabel}" has been answered`,
          `${otherLabel} answered`,
          (cond) => cond.questionId === other.id && cond.answered,
          () => ({ questionId: other.id, answered: true }),
        ));
      }
    });

    row.appendChild(conditionRow);
  }

  // "duration" (timer) questions: configure which skip button they control.
  if (q.type === "duration") {
    const timerRow = document.createElement("div");
    timerRow.className = "config-row";

    const targetSelect = document.createElement("select");
    targetSelect.title = "Which skip button this timer controls";
    [
      ["", "Not linked to a skip option"],
      ["tab", "Controls: \"Skip this tab\""],
      ["domain", "Controls: \"Skip this site\""],
    ].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (val === (q.tempAllowTarget ?? "")) opt.selected = true;
      targetSelect.appendChild(opt);
    });
    targetSelect.addEventListener("change", () => {
      workingQuestions[i].tempAllowTarget = targetSelect.value || undefined;
    });

    timerRow.appendChild(targetSelect);
    row.appendChild(timerRow);
  }

  // Split questions: name the Yes/No log tables. Left blank, each
  // defaults to "<log name> — Yes" / "<log name> — No".
  if (q.type === "bool" && q.isBranchSplit) {
    const branchRow = document.createElement("div");
    branchRow.className = "config-row";

    const rowLabel = document.createElement("span");
    rowLabel.textContent = "Log table names:";
    rowLabel.style.cssText = "font-size:0.75rem; color:#888; margin-right:auto; align-self:center;";
    branchRow.appendChild(rowLabel);

    const defaultBase = q.shortLabel?.trim() || q.text?.trim() || "(untitled)";

    ["yes", "no"].forEach((suffix) => {
      const badge = document.createElement("span");
      badge.className = `branch-label ${suffix}`;
      badge.textContent = suffix === "yes" ? "Y" : "N";
      badge.style.cssText = "flex-shrink:0; width:1.2rem; height:1.2rem; font-size:0.65rem;";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "branch-name-input";
      input.dataset.branchId = q.id;
      input.dataset.branchSuffix = suffix;
      input.value = q.branchLabels?.[suffix] || "";
      input.placeholder = `${defaultBase} — ${suffix === "yes" ? "Yes" : "No"}`;
      input.title = `Log table name when this question is answered ${suffix === "yes" ? "Yes" : "No"} (defaults to the placeholder shown)`;
      input.addEventListener("input", () => {
        workingQuestions[i].branchLabels = { ...workingQuestions[i].branchLabels, [suffix]: input.value };
      });

      branchRow.appendChild(badge);
      branchRow.appendChild(input);
    });

    row.appendChild(branchRow);
  }

  return row;
}

// ── Questions: List view ────────────────────────────────────────

function renderQuestions() {
  const list = document.getElementById("question-list");
  list.innerHTML = "";

  cleanupStaleShowIf();

  // A question with exactly one trigger condition is drawn as a nested
  // child of it, connected by a line with a badge showing which answer
  // reveals it (Y/N, or "•" for a plain "answered" condition). A converging
  // question (more than one condition) can't be nested under just one
  // parent, so it's drawn flat instead — its "Show only if" chips already
  // show every condition inline.
  const nestedKindById = new Map(); // questionId -> "yes" | "no" | "answered"
  workingQuestions.forEach((q) => {
    if (q.showIf?.length !== 1) return;
    const cond = q.showIf[0];
    nestedKindById.set(q.id, cond.answered ? "answered" : cond.equals ? "yes" : "no");
  });

  workingQuestions.forEach((q, i) => {
    const row = buildQuestionRow(q, i, { showPositionControls: true });
    const nestedKind = nestedKindById.get(q.id);

    if (nestedKind) {
      row.classList.add("nested");
      const wrapper = document.createElement("div");
      wrapper.className = "branch-wrapper";

      const connector = document.createElement("div");
      connector.className = "branch-connector";

      const label = document.createElement("span");
      label.className = `branch-label ${nestedKind}`;
      label.textContent = nestedKind === "yes" ? "Y" : nestedKind === "no" ? "N" : "•";

      connector.appendChild(label);
      wrapper.appendChild(connector);
      wrapper.appendChild(row);
      list.appendChild(wrapper);
    } else {
      list.appendChild(row);
    }
  });
}

// ── Questions: Flowchart view ────────────────────────────────────
//
// A question can converge from more than one branch (its showIf conditions
// are OR'd), so this can't be laid out as a strict tree — the same node
// might need an incoming arrow from two unrelated ancestors. Instead,
// questions are grouped into rows by "level" (1 + the deepest of its
// trigger questions' levels; 0 for always-shown questions), each row laid
// out with flexbox, and then arrows are drawn on an SVG overlay connecting
// every trigger to every question that depends on it, using their actual
// on-screen coordinates after layout. This needs no charting library —
// just getBoundingClientRect() once the boxes have been placed.

const SVG_NS = "http://www.w3.org/2000/svg";

// Focuses the text input inside whichever detail panel is currently open in
// the flowchart (there's at most one at a time).
function focusSelectedTreeInput() {
  document.querySelector("#tree-view .question-row input")?.focus();
}

// Handles dropping a dragged node onto a branch slot (or the root slot,
// when targetCondition is undefined): rejects drops that would create a
// cycle (including dropping a node onto itself), otherwise reparents it.
function handleTreeDrop(e, targetCondition) {
  const draggedId = e.dataTransfer.getData("application/x-intentio-tree-node");
  if (!draggedId) return;
  if (targetCondition && collectSubtreeIds(draggedId).has(targetCondition.questionId)) return;

  moveSubtreeToEnd(draggedId, targetCondition);
  renderTree();
}

// A dashed box that both creates a new question under `condition`
// (undefined = root/always shown) and accepts a dropped node to move it
// there instead — click to add, drag a node onto it to relocate that node
// here (replacing whatever conditions it had). To make a question converge
// from more than one branch, check additional boxes in its detail panel
// instead of dragging. `answer` ("yes"/"no"/"answered"/undefined) just
// colors the box to match its branch.
function buildFlowAddSlot(condition, answer) {
  const slot = document.createElement("div");
  slot.className = "flow-add-slot" + (answer ? ` ${answer}` : "");
  slot.textContent = answer === "answered" ? "+ Next" : answer ? `+ ${answer === "yes" ? "Yes" : "No"}` : "+";
  slot.title = "Add a question here, or drag a question onto this to move it here";

  slot.addEventListener("click", () => {
    addQuestionWithShowIf(condition);
    renderTree();
    focusSelectedTreeInput();
  });
  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    slot.classList.add("drag-over");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    slot.classList.remove("drag-over");
    handleTreeDrop(e, condition);
  });

  return slot;
}

// Builds one flowchart node: just the box itself (draggable to move,
// clickable to toggle the shared detail panel) plus the detail panel when
// selected. No children are nested inside it — with convergence, a node
// can have more than one trigger, so layout is row-by-row (see renderTree),
// not nested recursion, and arrows are drawn separately in drawTreeArrows.
function buildFlowNode(q) {
  const i = workingQuestions.indexOf(q);
  const wrapper = document.createElement("div");
  wrapper.className = "flow-node-wrapper";
  wrapper.dataset.treeNodeId = q.id;

  const box = document.createElement("div");
  box.className = "flow-node";
  if (selectedTreeNodeId === q.id) box.classList.add("selected");
  box.textContent = q.shortLabel?.trim() || q.text?.trim() || "(untitled)";
  box.title = "Click to view/edit — drag to move this question";
  box.draggable = true;

  box.addEventListener("click", () => {
    selectedTreeNodeId = selectedTreeNodeId === q.id ? null : q.id;
    renderTree();
  });
  box.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("application/x-intentio-tree-node", q.id);
    e.dataTransfer.effectAllowed = "move";
  });

  wrapper.appendChild(box);

  if (selectedTreeNodeId === q.id) {
    const detail = buildQuestionRow(q, i, { showPositionControls: false });
    detail.classList.add("flow-detail");
    wrapper.appendChild(detail);
  }

  return wrapper;
}

// Assigns each question a "level": 0 if it's always shown, otherwise 1 +
// the deepest level among its trigger questions. This is what places a
// converging question in a single row below the deepest of its triggers,
// however many of them there are.
function computeLevels(questions) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const levels = new Map();

  function levelOf(q) {
    if (levels.has(q.id)) return levels.get(q.id);
    levels.set(q.id, 0); // guards against a cycle while it's being computed
    let level = 0;
    for (const cond of q.showIf ?? []) {
      const parent = byId.get(cond.questionId);
      if (parent) level = Math.max(level, levelOf(parent) + 1);
    }
    levels.set(q.id, level);
    return level;
  }

  questions.forEach(levelOf);
  return levels;
}

// Draws an arrow from every trigger question's box to each question that
// depends on it, using their actual rendered positions — this is what
// makes it look like a flowchart rather than an indented list, and what
// shows convergence (a box with more than one incoming arrow). Colored
// green for a "Yes" branch, red for "No", blue for a plain "answered"
// condition. Must run after the boxes are in the DOM and laid out (so
// getBoundingClientRect() values are final), and again on resize, since
// reflowing can move every box.
function drawTreeArrows(container) {
  container.querySelector("svg.tree-arrows")?.remove();

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "tree-arrows");

  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML = `
    <marker id="tree-arrow-yes" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#16a34a"></path>
    </marker>
    <marker id="tree-arrow-no" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#dc2626"></path>
    </marker>
    <marker id="tree-arrow-answered" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#2563eb"></path>
    </marker>`;
  svg.appendChild(defs);

  const containerRect = container.getBoundingClientRect();
  const boxFor = (id) => container.querySelector(`.flow-node-wrapper[data-tree-node-id="${id}"] > .flow-node`);
  const colorFor = { yes: "#16a34a", no: "#dc2626", answered: "#2563eb" };

  workingQuestions.forEach((q) => {
    if (!q.showIf?.length) return;
    const childBox = boxFor(q.id);
    if (!childBox) return;
    const cRect = childBox.getBoundingClientRect();

    q.showIf.forEach((cond) => {
      const parentBox = boxFor(cond.questionId);
      if (!parentBox) return;
      const pRect = parentBox.getBoundingClientRect();

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", pRect.left + pRect.width / 2 - containerRect.left);
      line.setAttribute("y1", pRect.bottom - containerRect.top);
      line.setAttribute("x2", cRect.left + cRect.width / 2 - containerRect.left);
      line.setAttribute("y2", cRect.top - containerRect.top - 6); // stop short so the arrowhead clears the box border
      const kind = cond.answered ? "answered" : cond.equals ? "yes" : "no";
      line.setAttribute("stroke", colorFor[kind]);
      line.setAttribute("stroke-width", "2");
      line.setAttribute("marker-end", `url(#tree-arrow-${kind})`);
      svg.appendChild(line);
    });
  });

  const width = Math.max(container.scrollWidth, container.clientWidth);
  const height = Math.max(container.scrollHeight, container.clientHeight);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  container.insertBefore(svg, container.firstChild); // behind the node boxes, drawn first
}

function renderTree() {
  const container = document.getElementById("tree-view");
  container.innerHTML = "";

  cleanupStaleShowIf();

  const levels = computeLevels(workingQuestions);
  const byLevel = new Map(); // level -> questions at that level
  workingQuestions.forEach((q) => {
    const lvl = levels.get(q.id);
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(q);
  });
  const maxLevel = Math.max(0, ...workingQuestions.map((q) => levels.get(q.id)));

  for (let lvl = 0; lvl <= maxLevel + 1; lvl++) {
    const row = document.createElement("div");
    row.className = "flow-row";

    (byLevel.get(lvl) ?? []).forEach((q) => row.appendChild(buildFlowNode(q)));

    // Every question one level up gets its add slot(s) here — this is "the
    // next row down" from it, whatever real children (from however many
    // other trigger questions) also land in this same row. Bool questions
    // get Yes/No slots; anything else just gets a single "answered" slot,
    // since it has no particular value to branch on.
    (byLevel.get(lvl - 1) ?? []).forEach((q) => {
      if (q.type === "bool") {
        row.appendChild(buildFlowAddSlot({ questionId: q.id, equals: true }, "yes"));
        row.appendChild(buildFlowAddSlot({ questionId: q.id, equals: false }, "no"));
      } else {
        row.appendChild(buildFlowAddSlot({ questionId: q.id, answered: true }, "answered"));
      }
    });

    if (lvl === 0) row.appendChild(buildFlowAddSlot(undefined, null)); // root: always-shown questions

    if (row.children.length > 0) container.appendChild(row);
  }

  // Arrows are measured from rendered box positions, so draw them only
  // once the browser has actually laid out what was just inserted.
  requestAnimationFrame(() => drawTreeArrows(container));
}

// Reflowing (e.g. resizing the window) can move every box, so redraw the
// arrows to match — only meaningful while the tree tab is actually visible.
window.addEventListener("resize", () => {
  if (activeQuestionsTab !== "tree") return;
  requestAnimationFrame(() => drawTreeArrows(document.getElementById("tree-view")));
});

document.getElementById("add-question-btn").addEventListener("click", () => {
  addQuestionWithShowIf(undefined);
  refreshActiveQuestionsView();
  if (activeQuestionsTab === "tree") {
    focusSelectedTreeInput();
  } else {
    const rows = document.querySelectorAll("#question-list .question-row");
    rows[rows.length - 1]?.querySelector("input")?.focus();
  }
});

// ── Whitelist ────────────────────────────────────────────────

function renderDomains() {
  const list = document.getElementById("domain-list");
  list.innerHTML = "";

  workingDomains.forEach((entry, i) => {
    const tag = document.createElement("div");
    tag.className = "domain-tag";

    const text = document.createElement("span");
    if (entry.scope === "file-prefix") {
      text.textContent = `📁 ${entry.pattern}`;
      text.title = "Local file/folder path";
    } else {
      text.textContent = entry.pattern;
      text.title = "Domain (and subdomains)";
    }

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.title = `Remove ${entry.pattern}`;
    removeBtn.addEventListener("click", () => {
      workingDomains.splice(i, 1);
      renderDomains();
    });

    tag.appendChild(text);
    tag.appendChild(removeBtn);
    list.appendChild(tag);
  });
}

function addDomain() {
  const input = document.getElementById("domain-input");
  const raw = input.value.trim();

  if (!raw) {
    input.focus();
    return;
  }

  let entry;
  if (raw.toLowerCase().startsWith("file://")) {
    // file:// URLs have no hostname, so domain matching doesn't apply —
    // store the path as-is (case preserved) and match by prefix instead.
    // Paste a folder path ending in "/" to whitelist everything inside it,
    // or a full file path to whitelist just that one file.
    entry = { pattern: raw, scope: "file-prefix" };
  } else {
    // Strip scheme and path — accept only the hostname
    let hostname = raw.toLowerCase();
    try {
      // If it looks like a URL, extract the hostname
      if (hostname.includes("://")) hostname = new URL(hostname).hostname;
      // Strip leading www. so "www.example.com" → "example.com"
      hostname = hostname.replace(/^www\./, "");
    } catch (_) {
      // not a URL, treat as-is
    }
    hostname = hostname.replace(/\/$/, ""); // strip trailing slash

    if (!hostname) {
      input.focus();
      return;
    }
    entry = { pattern: hostname, scope: "domain" };
  }

  if (workingDomains.some((d) => d.pattern === entry.pattern && d.scope === entry.scope)) {
    input.focus();
    return;
  }

  workingDomains.push(entry);
  renderDomains();
  input.value = "";
  input.focus();
}

document.getElementById("add-domain-btn").addEventListener("click", addDomain);
document.getElementById("domain-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addDomain(); }
});

// ── Save ──────────────────────────────────────────────────────

document.getElementById("save-btn").addEventListener("click", async () => {
  // Validate: require non-empty text on all questions
  if (workingQuestions.some((q) => !q.text.trim())) {
    alert("All questions must have text before saving.");
    return;
  }

  const focusTimeoutMinutes = parseInt(document.getElementById("focus-timeout-input").value, 10);
  if (!Number.isFinite(focusTimeoutMinutes) || focusTimeoutMinutes < 1) {
    alert("Tab focus timeout must be a number of minutes, 1 or greater.");
    return;
  }

  const config = await getConfig();

  // Write working copies back into config
  config.questions = workingQuestions.map((q) => ({
    ...q,
    text: q.text.trim(),
    shortLabel: q.shortLabel?.trim() || undefined,
    branchLabels: q.isBranchSplit
      ? { yes: q.branchLabels?.yes?.trim() || undefined, no: q.branchLabels?.no?.trim() || undefined }
      : undefined,
  }));
  config.whitelists[config.activeWhitelistId].alwaysAllowed = [...workingDomains];
  config.allowTimerFollowups = document.getElementById("allow-timer-followups-checkbox").checked;
  config.focusTimeoutMinutes = focusTimeoutMinutes;

  await saveConfig(config);

  // Brief "Saved!" confirmation
  const status = document.getElementById("save-status");
  status.style.display = "inline";
  setTimeout(() => { status.style.display = "none"; }, 2000);
});

// ── Pause Intentio ──────────────────────────────────────────────

// Refreshes the active-pause banner from the service worker's current
// state — called on load, and after starting/ending a pause.
async function refreshPauseStatus() {
  const status = await chrome.runtime.sendMessage({ type: "GET_PAUSE_STATUS" });
  const box = document.getElementById("pause-active-status");

  if (!status?.active) {
    box.style.display = "none";
    return;
  }

  const until = new Date(status.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  document.getElementById("pause-active-text").textContent = `Paused until ${until} — "${status.reason}"`;
  box.style.display = "flex";
}

document.getElementById("pause-btn").addEventListener("click", async () => {
  const minutes = parseInt(document.getElementById("pause-minutes-input").value, 10);
  const reason = document.getElementById("pause-reason-input").value.trim();

  if (!Number.isFinite(minutes) || minutes < 1) {
    alert("Enter a number of minutes, 1 or greater.");
    return;
  }
  if (!reason) {
    alert("Enter a reason for pausing — it's saved to the log.");
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "PAUSE_INTENTIO", minutes, reason });
  if (!response?.ok) {
    alert("Couldn't start the pause. Try again.");
    return;
  }

  document.getElementById("pause-reason-input").value = "";
  refreshPauseStatus();
});

document.getElementById("resume-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESUME_INTENTIO" });
  refreshPauseStatus();
});

// ── Backup & Restore ────────────────────────────────────────────

document.getElementById("export-btn").addEventListener("click", async () => {
  const data = await exportAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `intentio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  URL.revokeObjectURL(url);
});

document.getElementById("import-btn").addEventListener("click", () => {
  document.getElementById("import-file-input").click();
});

document.getElementById("import-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // reset so selecting the same file again still fires "change"
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (_) {
    alert("That file isn't valid backup JSON.");
    return;
  }

  if (!data.config || !Array.isArray(data.log)) {
    alert("That file doesn't look like an Intentio backup.");
    return;
  }

  if (!confirm("This will replace your current questions, always-allowed sites, and log with the contents of this file. Continue?")) {
    return;
  }

  await importAllData(data);

  // Reload so the form (and in-memory working copies) reflect the restored config
  location.reload();
});

// ── Init ─────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("log-link").href = chrome.runtime.getURL("log.html");

  const config = await getConfig();
  // Shallow copy each question, plus its own copy of the showIf list (an
  // array now, since a question can converge from more than one condition).
  workingQuestions = config.questions.map((q) => ({ ...q, showIf: q.showIf ? [...q.showIf] : undefined }));
  workingDomains = config.whitelists[config.activeWhitelistId].alwaysAllowed.map((d) => ({ ...d }));
  document.getElementById("allow-timer-followups-checkbox").checked = config.allowTimerFollowups !== false;
  document.getElementById("focus-timeout-input").value = config.focusTimeoutMinutes ?? DEFAULT_CONFIG.focusTimeoutMinutes;

  showQuestionsTab("tree");
  renderDomains();
  refreshPauseStatus();
});
