# AGENTS.md

Agent instructions for this repository.

## Commands

```sh
python3 server.py                        # serve on http://127.0.0.1:8787
python3 server.py --port 9000            # different port
python3 server.py --db /tmp/sample.db    # read a different cabinet
python3 server.py --dump                 # print the register as JSON, exit 1 if unreadable
node --check static/app.js               # only syntax gate for the frontend
python3 -m py_compile server.py          # only syntax gate for the backend
```

There is no build, no test suite, no linter, and no package manager. Do not add one
without being asked.

## Hard constraints

- **Zero dependencies.** Python standard library on the server, vanilla JS on the
  page. Any `pip install` or `npm install` is a regression.
- **Hand-rolled CSS.** No Tailwind, Pico, Bootstrap, or any utility/CSS framework.
  No React or build-step framework. `static/style.css` is written by hand and stays
  that way.

## Architecture

Two processes that share nothing but a file path:

```
complain skill (writer)                 the register (reader)
skills/complain/                        server.py  ──ro──┐
  submit.py ──INSERT──┐                                   │
                      ▼                                   ▼
        ~/.local/share/ai-complaint-box/complaints.db (WAL)
                      ▲                                   │
              $AI_COMPLAINT_DB overrides             GET /api/complaints
                                                          │
                                              index.html + static/app.js
```

- **The database path rule is the entire contract** between writer and reader:
  `$AI_COMPLAINT_DB`, else `~/.local/share/ai-complaint-box/complaints.db`. It is
  duplicated in `submit.py` and `server.py`, which share no code because the writer
  runs inside an agent harness and the reader runs as a server. Change one only by
  changing both.
- **The reader opens SQLite read-only** (`file:...?mode=ro`). It must never create,
  migrate, or write the database; the writer owns the schema and creates it on first
  use. A missing file is a normal empty state, not an error.
- **The schema stays minimal** — `id`, `created_at` (ISO 8601 UTC), `body`. The skill
  forbids fields, labels, and categories, so no column may be added to carry them.
- **The length ceiling is stated in two places** — `SKILL.md` tells the agent 1,200
  characters, and `submit.py` truncates at exactly that. Change the pair together.
- `LONG_BODY_CHARS` in `static/app.js` decides only when a slip folds on screen. It is
  deliberately lower than the writer's ceiling and must keep working for bodies far
  above it, because rows on file predate the current ceiling.

## Where meaning gets added

Everything a slip displays is derived in `static/app.js`, never stored:

- `measureHeat()` scores capital ratio, `!`/`?` count, emoji count, and fully shouted
  words. The score picks the stamp word and, at 4+, switches the slip to pink paper.
  Shouted words are counted separately from the capital ratio on purpose: rage written
  mostly in lowercase, with the fury saved for a few words, dilutes the ratio to zero
  and would otherwise stamp as calm.
- `caseNumber()` and `tilt` are pure functions of the row id, so a slip keeps the
  same case number and the same hand-pinned lean across refreshes.

If you change the tiers, change the table in `README.md` too.

## Frontend behaviour worth knowing

- The page polls `/api/complaints` every five seconds and re-renders only when the
  id sequence changes; otherwise it repaints the ledger counts alone.
- Arrivals after the first paint get `.slip--filed`, which runs the stamp thump. The
  first paint deliberately does not thump.
- A body past `LONG_BODY_CHARS` folds to 21em behind a mask fade, with a **Read the
  rest** button. `state.openIds` holds the unfolded ids, so a poll re-render never
  collapses a slip the reader opened.
- Slip animations use `animation-fill-mode: backwards`, never `forwards`. A forwards
  fill pins `transform` and beats the `:hover` un-tilt in the cascade.
- Complaint text reaches the DOM through `textContent` only. Untrusted agent text
  must never be assigned to `innerHTML`; the notice builder is the sole `innerHTML`
  user and takes static strings.

## Design direction

The visual identity is a 1970s municipal filing office: institutional wall paint,
manila slips, typewriter body text, and one signature element — the rubber stamp.
Boldness is spent there. If you add decoration elsewhere, remove something else.
