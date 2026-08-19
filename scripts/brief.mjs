#!/usr/bin/env node
// GSD 2.1 brief generator — runs in GitHub Actions on a schedule (or manually).
// Modes: morning (plan the day; Mondays open the week), midday (check-in),
// evening (review + strikes; Fridays become the weekly review), weekly (forced).
// Uses the Todoist unified API (/api/v1) and the Anthropic API. No npm dependencies.
//
// 2.1 changes: the Three is never padded with tasks that are not due, and every
// brief leads with the week's stated outcome and where the work sits in the plan.

const TODOIST_TOKEN = need("TODOIST_TOKEN");
const ANTHROPIC_API_KEY = need("ANTHROPIC_API_KEY");
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const MODEL = process.env.GSD_MODEL || "claude-sonnet-4-5";
const TZ = process.env.GSD_TZ || "America/New_York";
const MODE = resolveMode(process.env.MODE);

const PIT_NAME = "Pit of Doom";
const STRIKE_LABELS = ["gsd-strike-1", "gsd-strike-2", "gsd-strike-3"];
const IGNORE_LABEL = "reference";   // source material, never nagged about
const OUTCOME_LABEL = "outcome";    // week markers: context, never a task

function need(k) {
  const v = process.env[k];
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
  return v;
}

function resolveMode(m) {
  if (["morning", "midday", "evening", "weekly"].includes(m)) return m;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date()));
  if (hour < 12) return "morning";
  if (hour < 16) return "midday";
  return "evening";
}

function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}

function localWeekday() {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(new Date());
}

function localDayOf(iso) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso)); }
  catch { return (iso || "").slice(0, 10); }
}

// ---------- Todoist (unified API, /api/v1) ----------
async function todoist(path, opts = {}) {
  const res = await fetch(`https://api.todoist.com/api/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TODOIST_TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Todoist ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// List endpoints are paginated: { results: [...], next_cursor: "..." }
async function todoistList(path) {
  const sep = path.includes("?") ? "&" : "?";
  let items = [], cursor = null;
  do {
    const page = await todoist(`${path}${sep}limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    items = items.concat(page.results || page.items || []);
    cursor = page.next_cursor || null;
  } while (cursor);
  return items;
}

async function getState() {
  const [projects, tasks, labels, sections] = await Promise.all([
    todoistList("/projects"),
    todoistList("/tasks"),
    todoistList("/labels"),
    todoistList("/sections").catch(() => []),
  ]);
  const pit = projects.find(p => p.name.includes(PIT_NAME)) || null;
  const projById = Object.fromEntries(projects.map(p => [p.id, p]));
  const sectById = Object.fromEntries(sections.map(s => [s.id, s]));
  return { projects, tasks, labels, sections, pit, projById, sectById };
}

async function ensureLabels(existing) {
  const have = new Set(existing.map(l => l.name));
  for (const name of [...STRIKE_LABELS, IGNORE_LABEL, OUTCOME_LABEL]) {
    if (!have.has(name)) await todoist("/labels", { method: "POST", body: JSON.stringify({ name }) });
  }
}

function strikeCount(task) {
  for (let i = 2; i >= 0; i--) if (task.labels.includes(STRIKE_LABELS[i])) return i + 1;
  return 0;
}

// Tasks the system must never pick, strike, or reschedule.
function isIgnored(task, pit) {
  return (pit && task.project_id === pit.id)
    || task.labels.includes(IGNORE_LABEL)
    || task.labels.includes(OUTCOME_LABEL);
}

async function addStrike(task, pit) {
  const n = strikeCount(task);
  if (n >= 3) return 3;
  const labels = task.labels.filter(l => !STRIKE_LABELS.includes(l)).concat(STRIKE_LABELS[n]);
  await todoist(`/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ labels }) });
  const total = n + 1;
  if (total >= 3 && pit) {
    await todoist(`/tasks/${task.id}/move`, { method: "POST", body: JSON.stringify({ project_id: pit.id }) });
  }
  return total;
}

async function reschedule(task, dueString) {
  if (task.due?.is_recurring) return; // never touch recurrence
  await todoist(`/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ due_string: dueString }) });
}

async function completedSince(daysBack) {
  try {
    const since = `${localDate(-daysBack)}T00:00:00`;
    const until = `${localDate(1)}T00:00:00`;
    return await todoistList(`/tasks/completed/by_completion_date?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
  } catch (e) {
    console.error("completedSince failed:", e.message);
    return [];
  }
}

// ---------- Streaks ----------
function computeStreaks(completedItems, recurringTasks) {
  const daysByContent = {};
  for (const it of completedItems) {
    const day = localDayOf(it.completed_at);
    (daysByContent[it.content] ||= new Set()).add(day);
  }
  return recurringTasks.map(t => {
    const days = daysByContent[t.content] || new Set();
    let streak = 0;
    let i = days.has(localDate(0)) ? 0 : -1; // streak may still be alive if today is not done yet
    for (; days.has(localDate(i)); i--) streak++;
    return { habit: t.content, streak, doneToday: days.has(localDate(0)) };
  });
}

// ---------- The bigger picture ----------
const cleanOutcome = s => s.replace(/^[\s*▸•\-]+/, "").trim();

function planShape(state) {
  const today = localDate(0);
  const { tasks, projById, sectById, pit } = state;

  const outcomes = tasks
    .filter(t => t.labels.includes(OUTCOME_LABEL) && t.due?.date)
    .sort((a, b) => (a.due.date < b.due.date ? -1 : 1));

  const past = outcomes.filter(o => o.due.date <= today);
  const currentDate = past.length ? past[past.length - 1].due.date : null;
  const thisWeek = currentDate
    ? outcomes.filter(o => o.due.date === currentDate).map(o => cleanOutcome(o.content))
    : [];
  const future = outcomes.filter(o => o.due.date > today);
  const nextDate = future.length ? future[0].due.date : null;
  const nextWeek = nextDate
    ? { date: nextDate, outcomes: future.filter(o => o.due.date === nextDate).map(o => cleanOutcome(o.content)) }
    : null;

  // Open work per section, so the brief can say where things stand.
  const buckets = {};
  for (const t of tasks) {
    if (isIgnored(t, pit) || t.parent_id) continue;
    const proj = projById[t.project_id]?.name || "?";
    const sect = t.section_id ? (sectById[t.section_id]?.name || "") : "";
    const key = sect ? `${proj} / ${sect}` : proj;
    const b = (buckets[key] ||= { open: 0, dueThisWeek: 0 });
    b.open++;
    if (t.due?.date && t.due.date <= localDate(7)) b.dueThisWeek++;
  }
  const shape = Object.entries(buckets)
    .filter(([, b]) => b.open > 0)
    .sort((a, b) => b[1].dueThisWeek - a[1].dueThisWeek || b[1].open - a[1].open)
    .slice(0, 8)
    .map(([k, b]) => `${k}: ${b.open} open, ${b.dueThisWeek} due within 7 days`);

  return { thisWeek, nextWeek, shape };
}

// ---------- Claude ----------
async function claude(system, user, maxTokens = 1200) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content.map(c => c.text || "").join("");
}

const GSD_SYSTEM = `You are GSD, Gareth's Getting Stuff Done coach. Voice: direct, warm, zero shame, zero corporate language, no em dashes, US spelling. Plans change; people don't fail them. Never moralize about incomplete tasks. Every recommended task must come with one concrete FIRST PHYSICAL ACTION (open X, write one sentence of Y, put Z in a bag) and a time estimate in minutes.

HARD RULE ON SELECTION: you may only recommend tasks from the list you are given as due. If there are fewer than three, recommend fewer and say plainly that the day is light. Never pad the list with something that is not due, and never invent a task. A short honest list beats three items where one is fiction. If the day is light you may mention at most one undated item from the offers list, clearly framed as optional.

Within what is due: finishing beats starting, P1 beats P2, and a task with strikes is being avoided, so name that gently and make its first action smaller.

A task whose note starts with "⏸" was deliberately parked by Gareth with a stated reason. Respect it: no shame, and when its date arrives ask in one line whether the blocker cleared rather than assuming.

Lead every brief with the week's stated outcome, so the day's work is visibly in service of something. Then the tasks. Ignore tasks labeled "reference" and anything in the Pit of Doom. Output plain markdown, no headers deeper than bold text, short lines that read well in a phone notification.`;

// context.md holds the plan behind the plan. It is optional; briefs still work without it.
let CONTEXT = "";
try {
  const fs = await import("node:fs");
  for (const p of ["context.md", "./context.md"]) {
    if (fs.existsSync(p)) { CONTEXT = fs.readFileSync(p, "utf8").slice(0, 9000); break; }
  }
} catch (e) { console.error("context.md not loaded:", e.message); }

const SYSTEM = GSD_SYSTEM + (CONTEXT
  ? `\n\n--- BACKGROUND: the plan behind the plan. Use it to make the brief specific and grounded, and to explain a task in half a line where a reminder helps. Never quote it at length or pad the brief with it. ---\n${CONTEXT}`
  : "");

function taskSummary(tasks, state) {
  const { projById, sectById, pit } = state;
  return tasks
    .filter(t => !isIgnored(t, pit))
    .map(t => ({
      id: t.id,
      task: t.content,
      project: projById[t.project_id]?.name || "?",
      section: t.section_id ? (sectById[t.section_id]?.name || null) : null,
      priority: `p${5 - t.priority}`, // API 4 = p1
      due: t.due?.date || null,
      recurring: !!t.due?.is_recurring,
      strikes: strikeCount(t),
      duration: t.duration ? `${t.duration.amount} ${t.duration.unit}` : null,
      note: (t.description || "").split("\n")[0].slice(0, 140) || null,
    }));
}

// ---------- Shared maintenance ----------
async function morningMaintenance(state, notes) {
  const today = localDate(0);
  for (const t of state.tasks) {
    if (isIgnored(t, state.pit) || !t.due?.date || t.due.date >= today || t.due.is_recurring) continue;
    const n = await addStrike(t, state.pit);
    if (n >= 3) { notes.push(`"${t.content}" hit 3 strikes and went to the Pit.`); continue; }
    await reschedule(t, "today");
    notes.push(`"${t.content}" was overdue: moved to today, strike ${n}.`);
  }
}

async function eveningMaintenance(state, notes) {
  const today = localDate(0);
  const unfinished = state.tasks.filter(t => !isIgnored(t, state.pit) && t.due?.date && t.due.date <= today && !t.due.is_recurring);
  for (const t of unfinished) {
    if ((5 - t.priority) <= 2) { // p1 or p2 take a strike and roll to tomorrow
      const n = await addStrike(t, state.pit);
      if (n >= 3) { notes.push(`"${t.content}" hit 3 strikes and went to the Pit.`); continue; }
      await reschedule(t, "tomorrow");
      notes.push(`"${t.content}" rolls to tomorrow, strike ${n}.`);
    } else {
      await reschedule(t, "tomorrow");
    }
  }
}

// ---------- Modes ----------
async function morning(state) {
  const today = localDate(0);
  const weekday = localWeekday();
  const isMonday = weekday === "Monday";
  await ensureLabels(state.labels);

  const notes = [];
  await morningMaintenance(state, notes);

  // Re-read after maintenance so rescheduled items are current.
  const fresh = await todoistList("/tasks");
  const freshState = { ...state, tasks: fresh };
  const all = taskSummary(fresh, freshState);

  // THE ONLY CANDIDATES ARE TASKS ACTUALLY DUE. No padding, ever.
  const due = all.filter(t => t.due && t.due <= today);
  const offers = all.filter(t => !t.due).slice(0, isMonday ? 25 : 8);
  const shape = planShape(freshState);

  const recurringOpen = fresh.filter(t => !isIgnored(t, state.pit) && t.due?.is_recurring);
  const streaks = computeStreaks(await completedSince(35), recurringOpen);

  const mondayBlock = isMonday ? `

This is MONDAY, so open the week before the day: restate the week's outcome, name the one thing that must be true by Friday, and point out anything undated in the offers list that deserves a day this week. Then the day's tasks. Maximum 240 words.` : `

Maximum 170 words.`;

  const brief = await claude(SYSTEM, `Morning brief for ${weekday} ${today}.

THE WEEK'S OUTCOME (lead with this): ${shape.thisWeek.length ? shape.thisWeek.join(" | ") : "none set"}
Next up: ${shape.nextWeek ? `${shape.nextWeek.date} — ${shape.nextWeek.outcomes.join(" | ")}` : "nothing further set"}
Where the work stands: ${shape.shape.join("; ") || "no open work"}

DUE TODAY (${due.length} item${due.length === 1 ? "" : "s"} — recommend from these ONLY): ${JSON.stringify(due)}
Optional undated offers (mention at most one, only if fewer than three are due): ${JSON.stringify(offers)}
Habit streaks: ${JSON.stringify(streaks)}
Maintenance already done: ${notes.length ? notes.join(" ") : "nothing was overdue."}

Write: the week's outcome in one line, then the day's tasks with first actions and estimates, then a focus target line. If a task belongs to a sequence or section, say which, so the day reads as part of the plan rather than a loose list.${mondayBlock}`, isMonday ? 1600 : 1200);

  return { title: isMonday ? "GSD week opener" : "GSD morning brief", body: brief + (notes.length ? `\n\n_${notes.join(" ")}_` : "") };
}

async function midday(state) {
  const today = localDate(0);
  const open = taskSummary(state.tasks, state).filter(t => t.due && t.due <= today);
  const done = (await completedSince(0)).map(i => i.content);
  const shape = planShape(state);

  const brief = await claude(SYSTEM, `Afternoon check-in for ${today}. Week's outcome: ${shape.thisWeek.join(" | ") || "none set"}. Done so far: ${JSON.stringify(done)}. Still open today: ${JSON.stringify(open)}. Write a checklist-style status (done / not done) and end with exactly one question about what happens next: continue, replan, or stuck. Maximum 80 words.`);
  return { title: "GSD check-in", body: brief };
}

async function evening(state) {
  const today = localDate(0);
  const done = (await completedSince(0)).map(i => i.content);
  const shape = planShape(state);

  const notes = [];
  await eveningMaintenance(state, notes);

  const brief = await claude(SYSTEM, `Evening review for ${today}. Week's outcome: ${shape.thisWeek.join(" | ") || "none set"}. Completed: ${JSON.stringify(done)}. Rolled forward: ${JSON.stringify(notes)}. Summarize what moved in plain terms and whether the week's outcome is still on track, with no judgment on what didn't move. End with: one optional question ("anything worth noting about today?") and the line "Day closed." Maximum 120 words.`);
  return { title: "GSD evening review", body: brief };
}

async function weekly(state) {
  const today = localDate(0);
  const { tasks, pit } = state;
  const shape = planShape(state);

  const notes = [];
  await eveningMaintenance(state, notes); // Friday still closes the day properly

  const weekDone = (await completedSince(6)).map(i => ({ task: i.content, day: localDayOf(i.completed_at) }));
  const open = taskSummary(tasks, state);
  const struck = open.filter(t => t.strikes > 0);
  const pitTasks = pit ? tasks.filter(t => t.project_id === pit.id).map(t => t.content) : [];
  const recurring = tasks.filter(t => !isIgnored(t, pit) && t.due?.is_recurring);
  const streaks = computeStreaks(await completedSince(35), recurring);

  const brief = await claude(SYSTEM, `WEEKLY REVIEW, Friday ${today}. This is the week's look-back, not a daily brief. Cover, in order:
1. The week's stated outcome and whether it actually happened. Be straight about it.
2. What got done this week, grouped, not itemized.
3. What's carrying strikes and what that avoidance might be about, in one gentle sentence.
4. The Pit: list its contents and ask the rescue question, does anything down there deserve one more chance or should it be deleted for good.
5. Habit streaks worth naming.
6. Next week's outcome, and the one thing that would make it happen.
End with "Week closed. See you Monday." Maximum 240 words.

This week's outcome was: ${shape.thisWeek.join(" | ") || "none set"}
Next week's outcome: ${shape.nextWeek ? `${shape.nextWeek.date} — ${shape.nextWeek.outcomes.join(" | ")}` : "nothing set"}
Where the work stands: ${shape.shape.join("; ") || "no open work"}
Completed this week: ${JSON.stringify(weekDone)}
Carrying strikes: ${JSON.stringify(struck)}
In the Pit: ${JSON.stringify(pitTasks)}
Habit streaks: ${JSON.stringify(streaks)}
Rolled tonight: ${JSON.stringify(notes)}`, 1800);

  return { title: "GSD weekly review", body: brief };
}

// ---------- Delivery ----------
async function notify({ title, body }) {
  const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN || "";
  const PUSHOVER_USER = process.env.PUSHOVER_USER || "";
  if (PUSHOVER_TOKEN && PUSHOVER_USER) {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: PUSHOVER_TOKEN,
        user: PUSHOVER_USER,
        title,
        message: body.slice(0, 1024), // Pushover message limit
      }),
    });
    if (!res.ok) throw new Error(`Pushover: ${res.status} ${await res.text()}`);
  }
  if (NTFY_TOPIC) {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: "default", Tags: "brain" },
      body,
    }).catch(() => {}); // ntfy is best-effort once Pushover is primary
  }
  const fs = await import("node:fs");
  fs.writeFileSync("brief_out.md", `# ${title}\n\n${body}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `subject=${title} — ${localDate(0)}\n`);
  }
  console.log(`\n=== ${title} ===\n${body}\n`);
}

const state = await getState();
const effectiveMode = MODE === "evening" && localWeekday() === "Friday" ? "weekly" : MODE;
const result =
  effectiveMode === "morning" ? await morning(state) :
  effectiveMode === "midday" ? await midday(state) :
  effectiveMode === "weekly" ? await weekly(state) :
  await evening(state);
await notify(result);
