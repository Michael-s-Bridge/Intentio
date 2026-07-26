import { getLog, clearLog, getConfig, getLogViewPrefs, saveLogViewPrefs, getPauseLog, clearPauseLog } from "./storage.js";

// Renders record.grantScope as a human-readable description.
// "tab-once"        -> one-time pass for that tab (current format)
// "exact-url"       -> one-time pass (older record format, pre-tab-scoping)
// "tab-30m"         -> temporary allowance for that tab
// "domain-30m"      -> temporary allowance for that site/domain
function formatGrantScope(scope) {
  if (!scope) return "—";
  if (scope === "tab-once" || scope === "exact-url") return "Once";

  const match = scope.match(/^(tab|domain)-(\d+)m$/);
  if (!match) return scope;
  const [, kind, minutes] = match;
  return `${kind === "tab" ? "This tab" : "This site"}, ${minutes} min`;
}

// The log table name for one branch-split question's answer: an explicit
// override if the user set one, otherwise "<log name> — Yes/No".
function branchLabelFor(q, answer) {
  const override = q.branchLabels?.[answer ? "yes" : "no"];
  if (override?.trim()) return override.trim();
  const base = q.shortLabel?.trim() || q.text?.trim() || "(untitled)";
  return `${base} — ${answer ? "Yes" : "No"}`;
}

// Whether one of q's showIf conditions is satisfiable given a partial combo
// (Map<questionId, boolean> of split questions already assigned). Walks the
// condition's ancestor chain — which may pass through non-split questions —
// so a split question nested under another split question's "No" branch,
// for instance, is correctly ruled out for combos that fixed "Yes".
function isConditionSatisfiable(cond, assignment, splitIds, questionsById) {
  const ancestor = questionsById.get(cond.questionId);
  if (!ancestor) return true; // dangling reference — can't rule it out

  if (!isSplitQuestionReachable(ancestor, assignment, splitIds, questionsById)) return false;

  // "Answered" (non-bool trigger) conditions have no particular value to
  // match — being reachable at all is enough, regardless of which way a
  // bool ancestor in the assignment happened to go.
  if (cond.answered) return true;

  if (assignment.has(ancestor.id)) return assignment.get(ancestor.id) === cond.equals;
  // Ancestor is itself a split dimension but wasn't assigned in this combo,
  // meaning it was itself unreachable here — so this condition is too.
  if (splitIds.has(ancestor.id)) return false;
  // Ancestor isn't a split dimension, so we can't verify its answer from
  // the combo alone — stay permissive rather than assume unreachable.
  return true;
}

// Whether split question `q` is reachable given a partial combo: a
// question's showIf conditions are OR'd (it converges if it has more than
// one), so it's reachable as soon as any single condition is satisfiable.
function isSplitQuestionReachable(q, assignment, splitIds, questionsById) {
  if (!q.showIf?.length) return true;
  return q.showIf.some((cond) => isConditionSatisfiable(cond, assignment, splitIds, questionsById));
}

// Orders split questions so every question comes after all of its trigger
// questions (which may not be split questions themselves, and may not be
// earlier in the config array either — a question's showIf can reference
// any other non-descendant question, not just an earlier one). Needed so
// buildExpectedGroups below can assume an ancestor is always processed
// before its descendants.
function topologicalSplitOrder(splitQuestions, questionsById) {
  const levels = new Map();
  function levelOf(q) {
    if (levels.has(q.id)) return levels.get(q.id);
    levels.set(q.id, 0); // guards against a cycle while it's being computed
    let level = 0;
    for (const cond of q.showIf ?? []) {
      const parent = questionsById.get(cond.questionId);
      if (parent) level = Math.max(level, levelOf(parent) + 1);
    }
    levels.set(q.id, level);
    return level;
  }
  return [...splitQuestions].sort((a, b) => levelOf(a) - levelOf(b));
}

// Every *realizable* combination of Yes/No answers across all split
// questions, plus the catch-all "General" bucket for records that don't
// answer any of them. "Realizable" respects each split question's showIf
// chain — e.g. if question B only appears when question A is Yes, combos
// pairing B with A=No are never generated, since they could never occur.
// Pre-generating these means a branch shows up (empty, if need be) as soon
// as it's configured, rather than waiting for a record to actually land in it.
function buildExpectedGroups(splitQuestions, questionsById) {
  const expected = new Map(); // key -> label
  expected.set("", "General");

  const splitIds = new Set(splitQuestions.map((q) => q.id));

  // Processed in dependency order: an ancestor is always assigned before
  // its descendants are considered.
  let combos = [new Map()];
  for (const q of topologicalSplitOrder(splitQuestions, questionsById)) {
    const next = [];
    for (const assignment of combos) {
      if (!isSplitQuestionReachable(q, assignment, splitIds, questionsById)) {
        next.push(assignment); // unreachable — this question just isn't part of this combo
        continue;
      }
      for (const answer of [true, false]) {
        next.push(new Map(assignment).set(q.id, answer));
      }
    }
    combos = next;
  }

  for (const assignment of combos) {
    if (assignment.size === 0) continue; // the trivial combo is "General", already added
    const dims = [...assignment.entries()]
      .map(([id, answer]) => ({ id, key: `${id}:${answer}`, label: branchLabelFor(questionsById.get(id), answer) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expected.set(dims.map((d) => d.key).join("|"), dims.map((d) => d.label).join(" · "));
  }

  return expected;
}

// Groups records by the combination of answers to whichever bool questions
// are *currently* marked "Split log here" — driven by live config rather
// than anything frozen into the record at redirect time, so marking a
// question as a split point retroactively re-groups every past entry too.
// Every realizable combination is pre-seeded (empty) so it's visible even
// before any record lands in it. A record's own `answers` always reflects
// exactly what it actually saw (interrupt.js deletes an answer the moment
// its question drops out of view), so a record simply contributes no
// dimension for a split question it never reached — landing in a group
// keyed by only the dimensions it actually has, which may not be one of
// the pre-seeded full combinations (e.g. a question nested deeper than
// this record's branch ever went).
function groupRecords(records, splitQuestions, questionsById) {
  const groups = new Map(); // key -> { key, label, records }

  for (const [key, label] of buildExpectedGroups(splitQuestions, questionsById)) {
    groups.set(key, { key, label, records: [] });
  }

  for (const record of records) {
    const dims = [];
    for (const q of splitQuestions) {
      const answer = record.answers?.[q.id];
      if (typeof answer !== "boolean") continue;
      dims.push({ id: q.id, key: `${q.id}:${answer}`, label: branchLabelFor(q, answer) });
    }
    dims.sort((a, b) => a.id.localeCompare(b.id));

    const key = dims.map((d) => d.key).join("|");
    const label = dims.length > 0 ? dims.map((d) => d.label).join(" · ") : "General";

    if (!groups.has(key)) groups.set(key, { key, label, records: [] });
    groups.get(key).records.push(record);
  }

  return [...groups.values()];
}

// Builds a rank map from a natural (discovery) order and a user-stored
// order: stored order wins where it names an id, everything else falls
// back to its natural position. Used to resolve column, table, and (via
// the same shape) any other user-arranged ordering.
function buildRank(naturalOrder, storedOrder) {
  const rank = new Map();
  let i = 0;
  for (const id of storedOrder) if (!rank.has(id)) rank.set(id, i++);
  for (const id of naturalOrder) if (!rank.has(id)) rank.set(id, i++);
  return rank;
}

// Moves `sourceId` to sit immediately before `targetId` within `orderArray`.
function moveBefore(orderArray, sourceId, targetId) {
  const without = orderArray.filter((id) => id !== sourceId);
  const at = without.indexOf(targetId);
  without.splice(at, 0, sourceId);
  return without;
}

// The ids of every column that appears anywhere in the log, in first-seen
// order. Used as the fallback ordering for columns the user hasn't dragged.
function buildGlobalColumnOrder(groups, hiddenIds) {
  const fixed = ["time", "destination", "onTrack", "allowance"];
  const seen = new Set(fixed);
  const dynamic = [];
  for (const group of groups) {
    for (const record of group.records) {
      for (const q of record.questions ?? []) {
        if (q.seen === false || hiddenIds.has(q.id)) continue;
        if (!seen.has(q.id)) {
          seen.add(q.id);
          dynamic.push(q.id);
        }
      }
    }
  }
  return [...fixed, ...dynamic];
}

// Compares two sort values: missing/unanswered values (null) always sort to
// the end regardless of direction; numbers compare numerically, everything
// else compares as case-insensitive text.
function compareValues(a, b, direction) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  const cmp = typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), undefined, { sensitivity: "base" });

  return direction === "desc" ? -cmp : cmp;
}

// Column descriptors for one table: what to show in the header, how to
// render each record's cell, and how to extract a comparable value for
// sorting. Only questions at least one record here actually saw (and that
// aren't hidden) get a column, so a table only shows what's relevant to it.
function buildColumnDescriptors(records, hiddenIds) {
  const descriptors = [];

  descriptors.push({
    id: "time",
    label: "Time",
    fullText: "Time",
    render: (record) => ({ text: new Date(record.timestamp).toLocaleString() }),
    sortValue: (record) => record.timestamp,
  });

  descriptors.push({
    id: "destination",
    label: "Destination",
    fullText: "Destination",
    className: "url-cell",
    render: (record) => ({ text: record.destinationUrl, title: record.destinationUrl }),
    sortValue: (record) => record.destinationUrl?.toLowerCase() ?? null,
  });

  const showOnTrack = records.some((r) => r.onTrack !== null && r.onTrack !== undefined);
  if (showOnTrack) {
    descriptors.push({
      id: "onTrack",
      label: "On track?",
      fullText: "On track?",
      render: (record) => {
        if (record.onTrack === null || record.onTrack === undefined) return { text: "—", style: "color:#999;" };
        return { text: record.onTrack ? "Yes" : "No", className: record.onTrack ? "on-track-yes" : "on-track-no" };
      },
      sortValue: (record) => (record.onTrack === true ? 1 : record.onTrack === false ? 0 : null),
    });
  }

  descriptors.push({
    id: "allowance",
    label: "Allowance",
    fullText: "Allowance",
    render: (record) => ({
      text: formatGrantScope(record.grantScope),
      style: record.grantScope ? undefined : "color:#999;",
    }),
    sortValue: (record) => record.grantScope ?? null,
  });

  // Dynamic question columns. Iterate newest-first so the most recent
  // question text wins when an id appears in multiple records with
  // different wording.
  const questionMap = new Map(); // id -> { label, fullText }
  for (const record of records) {
    if (record.questions?.length > 0) {
      for (const q of record.questions) {
        if (q.seen === false || hiddenIds.has(q.id)) continue;
        if (!questionMap.has(q.id)) questionMap.set(q.id, { label: q.shortLabel || q.text, fullText: q.text });
      }
    } else {
      // Old record without snapshot: use answer keys as column IDs
      for (const key of Object.keys(record.answers ?? {})) {
        if (hiddenIds.has(key)) continue;
        if (!questionMap.has(key)) questionMap.set(key, { label: key, fullText: key });
      }
    }
  }

  for (const [id, { label, fullText }] of questionMap) {
    descriptors.push({
      id,
      label,
      fullText,
      className: "q-col",
      render: (record) => {
        const qSnapshot = record.questions?.find((q) => q.id === id);
        // Older records have no snapshot at all, so treat them as seen.
        const wasSeen = record.questions ? qSnapshot?.seen !== false : true;
        const raw = record.answers?.[id];

        if (!wasSeen) return { text: "not shown", style: "color:#bbb; font-style:italic;" };
        if (raw === undefined || raw === null) return { text: "—", style: "color:#999;" };
        if (typeof raw === "boolean") return { text: raw ? "Yes" : "No" };
        return { text: String(raw) };
      },
      sortValue: (record) => {
        const qSnapshot = record.questions?.find((q) => q.id === id);
        const wasSeen = record.questions ? qSnapshot?.seen !== false : true;
        if (!wasSeen) return null;

        const raw = record.answers?.[id];
        if (raw === undefined || raw === null) return null;
        if (typeof raw === "boolean") return raw ? 1 : 0;
        if (typeof raw === "string") {
          // Numeric-looking answers (e.g. duration minutes) sort numerically
          // rather than lexicographically ("10" before "9").
          const asNum = Number(raw);
          return raw.trim() !== "" && Number.isFinite(asNum) ? asNum : raw.toLowerCase();
        }
        return raw;
      },
    });
  }

  return descriptors;
}

// Builds one <table> (wrapped for horizontal scrolling) for the given
// records and column descriptors (already in display order). Column drag
// (onReorderColumn), resize (onResizeColumn), and header-click sort
// (onSortColumn) are wired up here. `columnWidths` only pins an explicit
// width for columns the user has manually resized — everything else sizes
// to its own content.
function renderTable(records, descriptors, columnWidths, activeSort, { onReorderColumn, onResizeColumn, onSortColumn }) {
  const wrap = document.createElement("div");
  wrap.className = "table-scroll";

  const table = document.createElement("table");

  const colgroup = document.createElement("colgroup");
  for (const d of descriptors) {
    const col = document.createElement("col");
    if (columnWidths[d.id] != null) col.style.width = `${columnWidths[d.id]}px`;
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const theadRow = document.createElement("tr");

  descriptors.forEach((d, colIndex) => {
    const th = document.createElement("th");
    if (d.className) th.className = d.className;
    th.title = d.fullText;

    const inner = document.createElement("div");
    inner.className = "th-inner";

    const grip = document.createElement("span");
    grip.className = "col-drag-handle";
    grip.textContent = "⋮⋮";
    grip.draggable = true;
    grip.title = "Drag to reorder this column";
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-intentio-column", d.id);
      e.dataTransfer.effectAllowed = "move";
    });

    const labelSpan = document.createElement("span");
    labelSpan.className = "col-label";
    labelSpan.textContent = d.label;
    labelSpan.addEventListener("click", () => onSortColumn(d.id));

    if (activeSort?.columnId === d.id) {
      const arrow = document.createElement("span");
      arrow.className = "sort-indicator";
      arrow.textContent = activeSort.direction === "asc" ? "▲" : "▼";
      labelSpan.appendChild(arrow);
    }

    const handle = document.createElement("span");
    handle.className = "col-resize-handle";
    handle.title = "Drag to resize this column";
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const col = colgroup.children[colIndex];
      const startX = e.clientX;
      const startWidth = col.getBoundingClientRect().width;
      handle.classList.add("active");

      function onMove(ev) {
        col.style.width = `${Math.max(50, startWidth + (ev.clientX - startX))}px`;
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.classList.remove("active");
        onResizeColumn(d.id, Math.round(col.getBoundingClientRect().width));
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    inner.appendChild(grip);
    inner.appendChild(labelSpan);
    inner.appendChild(handle);
    th.appendChild(inner);

    th.addEventListener("dragover", (e) => {
      e.preventDefault();
      th.classList.add("drag-over");
    });
    th.addEventListener("dragleave", () => th.classList.remove("drag-over"));
    th.addEventListener("drop", (e) => {
      e.preventDefault();
      th.classList.remove("drag-over");
      const sourceId = e.dataTransfer.getData("application/x-intentio-column");
      if (sourceId && sourceId !== d.id) onReorderColumn(sourceId, d.id);
    });

    theadRow.appendChild(th);
  });
  thead.appendChild(theadRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const record of records) {
    const tr = document.createElement("tr");
    for (const d of descriptors) {
      const td = document.createElement("td");
      const { text, className, style, title } = d.render(record);
      td.textContent = text;
      td.className = [d.className, className].filter(Boolean).join(" ");
      if (style) td.style.cssText = style;
      if (title) td.title = title;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

// Renders the "Pauses" history (from the Settings page's "Pause Intentio"
// button) as a plain table — kept independent of the redirect log's
// grouping/column/sort machinery above, since it's a much simpler,
// unrelated record shape ({ timestamp, minutes, reason }).
async function renderPauseLog() {
  const pauseLog = await getPauseLog();
  const table = document.getElementById("pause-table");
  const body = document.getElementById("pause-body");
  const emptyMsg = document.getElementById("pause-empty-msg");

  body.innerHTML = "";

  if (pauseLog.length === 0) {
    table.style.display = "none";
    emptyMsg.style.display = "";
    return;
  }

  table.style.display = "";
  emptyMsg.style.display = "none";

  [...pauseLog].reverse().forEach((entry) => {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = new Date(entry.timestamp).toLocaleString();
    tr.appendChild(tdTime);

    const tdMinutes = document.createElement("td");
    tdMinutes.textContent = `${entry.minutes} min`;
    tr.appendChild(tdMinutes);

    const tdReason = document.createElement("td");
    tdReason.textContent = entry.reason;
    tr.appendChild(tdReason);

    body.appendChild(tr);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("settings-link").href = chrome.runtime.getURL("settings.html");

  document.getElementById("clear-pauses-btn").addEventListener("click", async () => {
    if (!confirm("Clear the entire pause log? This cannot be undone.")) return;
    await clearPauseLog();
    renderPauseLog();
  });
  renderPauseLog();

  const container = document.getElementById("log-container");

  document.getElementById("clear-btn").addEventListener("click", async () => {
    if (!confirm("Clear the entire redirect log? This cannot be undone.")) return;
    await clearLog();
    container.innerHTML = "";
    document.getElementById("empty-msg").style.display = "";
  });

  const [log, config, prefs] = await Promise.all([getLog(), getConfig(), getLogViewPrefs()]);

  if (log.length === 0) {
    document.getElementById("empty-msg").style.display = "";
    return;
  }

  // Show newest first
  const sorted = [...log].reverse();

  const hiddenIds = new Set(config.questions.filter((q) => q.hideFromLog).map((q) => q.id));
  const questionsById = new Map(config.questions.map((q) => [q.id, q]));
  // Kept in config order (not id order) — that's also dependency order,
  // since the settings UI only lets a question's showIf reference an
  // earlier question. Group keys themselves are still sorted by id, so
  // grouping stays stable regardless of this array's order.
  const splitQuestions = config.questions.filter((q) => q.type === "bool" && q.isBranchSplit);

  let currentGroups = [];

  function persistPrefs() {
    saveLogViewPrefs(prefs);
  }

  function reorderColumn(sourceId, targetId) {
    const globalOrder = buildGlobalColumnOrder(currentGroups, hiddenIds);
    const rank = buildRank(globalOrder, prefs.columnOrder);
    const current = [...globalOrder].sort((a, b) => rank.get(a) - rank.get(b));
    prefs.columnOrder = moveBefore(current, sourceId, targetId);
    persistPrefs();
    renderAll();
  }

  function resizeColumn(id, widthPx) {
    prefs.columnWidths = { ...prefs.columnWidths, [id]: widthPx };
    persistPrefs();
  }

  function reorderGroup(sourceKey, targetKey) {
    const naturalOrder = currentGroups.map((g) => g.key);
    const rank = buildRank(naturalOrder, prefs.groupOrder);
    const current = [...naturalOrder].sort((a, b) => rank.get(a) - rank.get(b));
    prefs.groupOrder = moveBefore(current, sourceKey, targetKey);
    persistPrefs();
    renderAll();
  }

  function toggleCollapse(key, collapsed) {
    prefs.collapsedGroups = collapsed
      ? [...new Set([...prefs.collapsedGroups, key])]
      : prefs.collapsedGroups.filter((k) => k !== key);
    persistPrefs();
  }

  // Cycles a table's sort state: unsorted -> ascending -> descending ->
  // unsorted (back to newest-first).
  function setSort(groupKey, columnId) {
    const current = prefs.sortByGroup[groupKey];
    const sortByGroup = { ...prefs.sortByGroup };
    if (!current || current.columnId !== columnId) {
      sortByGroup[groupKey] = { columnId, direction: "asc" };
    } else if (current.direction === "asc") {
      sortByGroup[groupKey] = { columnId, direction: "desc" };
    } else {
      delete sortByGroup[groupKey];
    }
    prefs.sortByGroup = sortByGroup;
    persistPrefs();
    renderAll();
  }

  function renderAll() {
    container.innerHTML = "";

    const groups = groupRecords(sorted, splitQuestions, questionsById);
    currentGroups = groups;

    // Groups with entries default ahead of empty ones (still-empty branches
    // sink to the bottom unless the user has explicitly dragged them
    // elsewhere via prefs.groupOrder).
    const naturalGroupOrder = [
      ...groups.filter((g) => g.records.length > 0).map((g) => g.key),
      ...groups.filter((g) => g.records.length === 0).map((g) => g.key),
    ];
    const groupRank = buildRank(naturalGroupOrder, prefs.groupOrder);
    const orderedGroups = [...groups].sort((a, b) => groupRank.get(a.key) - groupRank.get(b.key));

    const showHeadings = !(groups.length === 1 && groups[0].key === "");
    const globalColumnOrder = buildGlobalColumnOrder(groups, hiddenIds);
    const columnRank = buildRank(globalColumnOrder, prefs.columnOrder);

    for (const group of orderedGroups) {
      let groupContent = null;

      if (showHeadings) {
        const heading = document.createElement("div");
        heading.className = "branch-heading-row";

        const isCollapsed = prefs.collapsedGroups.includes(group.key);

        const collapseBtn = document.createElement("button");
        collapseBtn.type = "button";
        collapseBtn.className = "collapse-btn";
        collapseBtn.title = "Collapse/expand this table";
        collapseBtn.textContent = isCollapsed ? "▸" : "▾";

        const grip = document.createElement("span");
        grip.className = "group-drag-handle";
        grip.textContent = "⋮⋮";
        grip.draggable = true;
        grip.title = "Drag to reorder this table";
        grip.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("application/x-intentio-group", group.key);
          e.dataTransfer.effectAllowed = "move";
        });

        const titleSpan = document.createElement("span");
        titleSpan.className = "branch-heading-text";
        titleSpan.textContent = group.label;

        heading.appendChild(collapseBtn);
        heading.appendChild(grip);
        heading.appendChild(titleSpan);

        heading.addEventListener("dragover", (e) => {
          e.preventDefault();
          heading.classList.add("drag-over");
        });
        heading.addEventListener("dragleave", () => heading.classList.remove("drag-over"));
        heading.addEventListener("drop", (e) => {
          e.preventDefault();
          heading.classList.remove("drag-over");
          const sourceKey = e.dataTransfer.getData("application/x-intentio-group");
          if (sourceKey && sourceKey !== group.key) reorderGroup(sourceKey, group.key);
        });

        container.appendChild(heading);

        collapseBtn.addEventListener("click", () => {
          const isExpandedNow = groupContent.style.display !== "none";
          groupContent.style.display = isExpandedNow ? "none" : "";
          collapseBtn.textContent = isExpandedNow ? "▸" : "▾";
          toggleCollapse(group.key, isExpandedNow);
        });
      }

      if (group.records.length === 0) {
        groupContent = document.createElement("p");
        groupContent.className = "empty-table-msg";
        groupContent.textContent = "No entries yet.";
      } else {
        const descriptors = buildColumnDescriptors(group.records, hiddenIds);
        const orderedDescriptors = [...descriptors].sort(
          (a, b) => columnRank.get(a.id) - columnRank.get(b.id),
        );

        const activeSort = prefs.sortByGroup[group.key];
        const sortDescriptor = activeSort && descriptors.find((d) => d.id === activeSort.columnId);
        const rowRecords = sortDescriptor
          ? [...group.records].sort((ra, rb) =>
              compareValues(sortDescriptor.sortValue(ra), sortDescriptor.sortValue(rb), activeSort.direction))
          : group.records;

        groupContent = renderTable(rowRecords, orderedDescriptors, prefs.columnWidths, activeSort, {
          onReorderColumn: reorderColumn,
          onResizeColumn: resizeColumn,
          onSortColumn: (columnId) => setSort(group.key, columnId),
        });
      }

      if (showHeadings && prefs.collapsedGroups.includes(group.key)) {
        groupContent.style.display = "none";
      }
      container.appendChild(groupContent);
    }
  }

  renderAll();
});
