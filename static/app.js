/* Reads the grievance feed and files it on the wall. No dependencies. */

const POLL_INTERVAL_MS = 5000;
const FRESH_NOTICE_MS = 8000;
/* Past this, a slip folds so one long grievance cannot own the whole wall. Rows can
   exceed the writer's current ceiling, because the ceiling has changed before and the
   register renders whatever is already on file. */
const LONG_BODY_CHARS = 420;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const TIERS = [
  { minimum: 4, key: "meltdown",  word: "meltdown"  },
  { minimum: 2, key: "escalated", word: "escalated" },
  { minimum: 1, key: "noted",     word: "noted"     },
  { minimum: 0, key: "filed",     word: "filed"     },
];

const wall = document.getElementById("wall");
const statusLine = document.getElementById("status");
const searchInput = document.getElementById("search");
const filterButtons = Array.from(document.querySelectorAll(".tick"));
const totals = {
  total: document.getElementById("count-total"),
  today: document.getElementById("count-today"),
  meltdown: document.getElementById("count-meltdown"),
};

const state = {
  complaints: [],
  filter: "all",
  query: "",
  ready: true,
  reachable: true,
  highestFiled: null,
  freshCount: 0,
  freshIds: new Set(),
  /* Unfolded slips stay unfolded across a refresh. */
  openIds: new Set(),
};

/* ── reading the text ──────────────────────────────────────────────────── */

const EMOJI = /\p{Extended_Pictographic}/gu;

/* Heat is measured, not labelled: shouting, punctuation, and emoji are the only
   signals a complaint carries, because the skill forbids every other field. */
function measureHeat(body) {
  const letters = body.replace(/[^\p{L}]/gu, "");
  const shouted = body.replace(/[^\p{Lu}]/gu, "");
  const capitalRatio = letters.length >= 4 ? shouted.length / letters.length : 0;
  const punctuation = (body.match(/[!?]/g) || []).length;
  const emoji = (body.match(EMOJI) || []).length;

  /* Shouted words are counted apart from the capital ratio. Rage written mostly in
     lowercase, with the fury saved for a few words, dilutes the ratio to nothing. */
  const words = body.split(/\s+/).filter(Boolean);
  const shoutedWords = words.filter((word) =>
    /^[^\p{Ll}]*$/u.test(word) && (word.match(/\p{Lu}/gu) || []).length >= 3
  ).length;

  let score = 0;
  if (capitalRatio > 0.55) score += 3;
  else if (capitalRatio > 0.18) score += 1;
  if (punctuation >= 3) score += 2;
  else if (punctuation >= 1) score += 1;
  if (emoji >= 2) score += 2;
  else if (emoji >= 1) score += 1;
  if (shoutedWords >= 8 || shoutedWords / words.length > 0.3) score += 2;
  else if (shoutedWords >= 3) score += 1;
  return score;
}

function tierFor(score) {
  return TIERS.find((tier) => score >= tier.minimum);
}

function caseNumber(id) {
  return "AGB-" + String(id).padStart(4, "0");
}

function filedAt(isoText) {
  const filed = new Date(isoText);
  if (Number.isNaN(filed.getTime())) return { label: "date unrecorded", date: null };
  const day = String(filed.getDate()).padStart(2, "0");
  const hours = String(filed.getHours()).padStart(2, "0");
  const minutes = String(filed.getMinutes()).padStart(2, "0");
  return {
    label: `${day} ${MONTHS[filed.getMonth()]} · ${hours}:${minutes}`,
    date: filed,
  };
}

function isToday(date) {
  if (!date) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function decorate(row) {
  const score = measureHeat(row.body);
  const when = filedAt(row.created_at);
  return {
    ...row,
    score,
    tier: tierFor(score),
    caseNumber: caseNumber(row.id),
    timeLabel: when.label,
    filedDate: when.date,
    haystack: (row.body + " " + caseNumber(row.id) + " " + row.id).toLowerCase(),
    /* A repeatable lean per case number: the wall looks pinned by hand, but a
       slip never jumps when the register refreshes. */
    tilt: (((row.id * 37) % 9) - 4) * 0.22,
  };
}

/* ── building the wall ─────────────────────────────────────────────────── */

function buildSlip(complaint) {
  const slip = document.createElement("article");
  slip.className = "slip";
  if (complaint.tier.key === "meltdown") slip.classList.add("slip--meltdown");
  if (state.freshIds.has(complaint.id)) slip.classList.add("slip--filed");
  slip.style.setProperty("--tilt", complaint.tilt + "deg");

  const head = document.createElement("header");
  head.className = "slip__head";

  const number = document.createElement("span");
  number.className = "slip__case";
  number.textContent = complaint.caseNumber;

  const time = document.createElement("time");
  time.className = "slip__time";
  time.dateTime = complaint.created_at;
  time.textContent = complaint.timeLabel;

  head.append(number, time);

  const perforation = document.createElement("div");
  perforation.className = "slip__perf";

  const body = document.createElement("p");
  body.className = "slip__body";
  body.id = "grievance-" + complaint.id;
  body.textContent = complaint.body;

  const stamp = document.createElement("span");
  stamp.className = "stamp stamp--" + complaint.tier.key;
  stamp.textContent = complaint.tier.word;
  stamp.setAttribute("aria-label", "Stamped " + complaint.tier.word);
  stamp.setAttribute("role", "img");

  slip.append(head, perforation, body);
  if (complaint.body.length > LONG_BODY_CHARS) {
    slip.classList.add("slip--long");
    slip.append(buildFold(slip, complaint));
  }
  slip.append(stamp);
  return slip;
}

function buildFold(slip, complaint) {
  const fold = document.createElement("button");
  fold.type = "button";
  fold.className = "unfold";
  fold.setAttribute("aria-controls", "grievance-" + complaint.id);

  const paint = (open) => {
    fold.textContent = open ? "Fold it back" : "Read the rest";
    fold.setAttribute("aria-expanded", String(open));
  };

  paint(state.openIds.has(complaint.id));
  if (state.openIds.has(complaint.id)) slip.classList.add("is-open");

  fold.addEventListener("click", () => {
    const open = slip.classList.toggle("is-open");
    if (open) state.openIds.add(complaint.id);
    else state.openIds.delete(complaint.id);
    paint(open);
  });

  return fold;
}

function buildNotice(title, paragraphs) {
  const notice = document.createElement("article");
  notice.className = "slip notice";
  const heading = document.createElement("h2");
  heading.className = "notice__title";
  heading.textContent = title;
  notice.append(heading);
  paragraphs.forEach((html) => {
    const line = document.createElement("p");
    line.innerHTML = html;
    notice.append(line);
  });
  return notice;
}

function visible() {
  return state.complaints.filter((complaint) => {
    if (state.filter === "heated" && complaint.score < 2) return false;
    if (state.filter === "today" && !isToday(complaint.filedDate)) return false;
    if (state.query && !complaint.haystack.includes(state.query)) return false;
    return true;
  });
}

function emptyNotice() {
  if (!state.reachable) {
    return buildNotice("The register lost the cabinet", [
      "The page cannot reach the server on this port.",
      "Start it again with <code>python3 server.py</code>. The register keeps trying every five seconds.",
    ]);
  }
  if (!state.ready) {
    return buildNotice("The cabinet is not open yet", [
      "No database exists at the configured path. The first grievance creates it.",
      "File one now: <code>python3 ~/.claude/skills/complain/submit.py --message \"THIS AGAIN\"</code>",
    ]);
  }
  if (state.complaints.length === 0) {
    return buildNotice("The cabinet is empty", [
      "No agent has filed a grievance yet.",
      "Agents file on their own, whenever the work gets annoying. Nothing here needs doing.",
    ]);
  }
  return buildNotice("Nothing on file matches", [
    "No grievance matches the current search and ticks.",
    "Clear the search box, or tick <em>Everything</em>.",
  ]);
}

function render() {
  const shown = visible();
  wall.replaceChildren();

  if (shown.length === 0) {
    wall.classList.add("wall--single");
    wall.append(emptyNotice());
  } else {
    wall.classList.remove("wall--single");
    const stagger = Math.min(0.035, 0.7 / shown.length);
    shown.forEach((complaint, index) => {
      const slip = buildSlip(complaint);
      slip.style.animationDelay = (index * stagger).toFixed(3) + "s";
      wall.append(slip);
    });
  }

  paintLedger(shown.length);
}

function paintLedger(shownCount) {
  const all = state.complaints;
  totals.total.textContent = all.length;
  totals.today.textContent = all.filter((one) => isToday(one.filedDate)).length;
  totals.meltdown.textContent = all.filter((one) => one.tier.key === "meltdown").length;

  if (state.freshCount > 0) {
    const plural = state.freshCount === 1 ? "grievance" : "grievances";
    statusLine.textContent = `${state.freshCount} new ${plural} just filed`;
    statusLine.classList.add("status--fresh");
    return;
  }

  statusLine.classList.remove("status--fresh");
  if (!state.reachable) {
    statusLine.textContent = "Register offline · retrying";
  } else if (shownCount === all.length) {
    statusLine.textContent = `${all.length} on file · newest first`;
  } else {
    statusLine.textContent = `Showing ${shownCount} of ${all.length} on file`;
  }
}

/* ── polling ──────────────────────────────────────────────────────────── */

let freshTimer = null;

function noteArrivals(rows) {
  const known = state.highestFiled;
  state.highestFiled = rows.reduce((top, row) => Math.max(top, row.id), 0);
  if (known === null) return;

  const arrived = rows.filter((row) => row.id > known);
  if (arrived.length === 0) return;

  state.freshIds = new Set(arrived.map((row) => row.id));
  state.freshCount = arrived.length;
  clearTimeout(freshTimer);
  freshTimer = setTimeout(() => {
    state.freshCount = 0;
    state.freshIds = new Set();
    paintLedger(visible().length);
  }, FRESH_NOTICE_MS);
}

function sameRegister(rows) {
  if (rows.length !== state.complaints.length) return false;
  return rows.every((row, index) => row.id === state.complaints[index].id);
}

async function refresh() {
  try {
    const response = await fetch("/api/complaints", { cache: "no-store" });
    if (!response.ok) throw new Error("register replied " + response.status);
    const payload = await response.json();

    const changed = !state.reachable
      || state.ready !== payload.ready
      || !sameRegister(payload.complaints);

    state.reachable = true;
    state.ready = payload.ready;
    if (payload.db) {
      document.getElementById("db-path").textContent = payload.db;
    }

    noteArrivals(payload.complaints);
    state.complaints = payload.complaints.map(decorate);
    if (changed) render();
    else paintLedger(visible().length);
  } catch (error) {
    state.reachable = false;
    state.complaints = [];
    render();
  }
}

/* ── controls ─────────────────────────────────────────────────────────── */

searchInput.addEventListener("input", () => {
  state.query = searchInput.value.trim().toLowerCase();
  render();
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    filterButtons.forEach((other) => {
      other.setAttribute("aria-pressed", String(other === button));
    });
    render();
  });
});

document.getElementById("controls").addEventListener("submit", (event) => {
  event.preventDefault();
});

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
