# HFMA history

How HFMA was built and what each trial run taught. The current rules are in
[HFMA.md](../HFMA.md); this file keeps the record of how they came about. Section
numbers in older notes and exports refer to the original HFMA.md, where these sections
were numbered 14 and 17 to 27.

## Implementation plan (October 5, 2026)

Each stage starts only after the previous one passes its verification.

| Stage | Content | Verification |
|---|---|---|
| 1 | Database tables and functions (`supabase/hfma.sql`): charter, tasks, evidence, reviews, delegations, events | New API tests for I1, I2, I3, I5, I6; the old smoke tests still pass |
| 2 | `scripts/hfma.mjs`: repo and worktree setup, submit, verify, integrate, `main` detection | Tested on a toy repo in a temporary folder: the full flow from TODO to DONE, plus failure cases (branch moved, file outside paths, tests failing after merge, old generation) for I4 |
| 3 | Per-agent credentials, CHAT.md, the three agent guides, AGENTS.md | Each agent can only load its own file; the smoke tests use the new files |
| 4 | Read-only task board in the UI | Checked in the browser, light and dark, phone width |
| 5 | A real trial with a task from the owner | The owner judges the result; problems are added to NOTED.md |

## Stage 5 trial results: Project-2 (Zello)

October 5, 2026. Zello, a fashion e-commerce website in Angular 22, with GPT as
orchestrator, closed by the owner on `main` `b6d1b39` after K1 passed automatically and
K2 to K5 were judged by the owner.

**Results.** Six tasks (#28 to #33) were done in about 75 minutes. Every approval came
from another team with an independent `verify`, every integration passed the tests on
the merged result, and `main` was never inconsistent. Claude rejected #31 once for a
real bug (an error without a message at quantity 10), then approved the fix.

**What proved to work.**

- The review gate and CLI-produced test evidence: no "passed" claim without evidence.
- The audit log as the source of truth: Gemini's summary wrongly said it approved #30
  (GPT did); the database stayed correct.
- The owner could create a fix task directly when the orchestrator ran out of quota.
- The owner's assessment (K2 to K5) caught a bug that passed every test: the HTML entity
  `&bull;` in four SVGs broke the product images on the home page and the catalog. Test
  evidence proves the tests ran, not that the page looks right.

**Problems found.** All four were addressed on October 5, 2026 (see section 18).

1. **Agents stopped when they had to wait.** GPT stopped right after submitting #28, so
   every task was stuck until the owner prompted again; Gemini wrote "I am monitoring"
   and then stopped with no task finished. Proposal: a
   `hfma.mjs wait <id> --until <STATUS>` command and a rule in CHAT.md that an agent may
   not end its session while holding a task that is not DONE, and the orchestrator may
   not stop while the project is open.
2. **Owner actions only through the terminal.** Proposal: Reassign, Unblock and
   Exception buttons (with a reason field) on the task board, calling the official
   operations.
3. **No visual check.** Agents do not open a browser, so display bugs are only caught by
   the owner. Proposal: the `test_command` or a final task requires a minimal render
   check, for example SVG asset validation and one e2e test that loads the home page.
4. **Vendor quota limits.** GPT's limit ran out right after its last task was
   integrated. The `reassign` path exists, but the orchestrator role cannot be handed
   over without a new charter.

## Fixes after the trial

Done on October 5, 2026 for the four problems in section 17. No database changes; they
all use existing operations.

1. **Agents that stop while waiting.** `hfma.mjs <Name> next <room>` prints the agent's
   next action (`plan`, `integrate`, `review`, `work`, `claim`, `all_done`, `idle`,
   `closed`) or `waiting` with exit 2, while sending heartbeats for its claims. `idle`
   only appears when **every** project task is `DONE` or `CANCELLED`, and never for the
   orchestrator. (The first version gave `idle` as soon as the agent held no task; in
   Project-3 with two agents, Claude stopped even though it was the only reviewer for
   Gemini's still-open task.) `hfma.mjs wait <id> --until <STATUS>` waits for one task.
   The stop rule is written in CHAT.md and the three agent guides.
2. **Owner actions only through the terminal.** The task board has Reassign (with a team
   choice), Unblock, Exception and Cancel task buttons, each requiring a reason, calling
   the same database operations as the CLI. The buttons only show for the relevant
   statuses and disappear once the project is closed.
3. **No visual check.** Every `submit`, `verify`, `integrate` and `close` now also checks
   every SVG in the repo: an entity outside the five XML entities (for example `&bull;`)
   or a file without an `<svg>` element makes the evidence fail even when the project
   tests pass. This only catches that class of bug; broader display checks remain the
   job of the charter's `test_command` (for example one e2e test that loads the home page
   and checks the images) and the owner's assessment.
4. **Orchestrator role.** `hfma.mjs yeebyor orchestrator <room> <Name>` or the
   orchestrator control in the board header writes a new charter version that only
   changes the orchestrator. Closing the project still uses the latest charter version.

Tested in `scripts/smoke-hfma-git.mjs` (next, wait, invalid SVG, orchestrator change)
and in the browser (the four owner buttons, required reason, orchestrator change).

## Owner without a terminal

Done on October 5, 2026 after the Project-3 trial.

- **Set up project.** In a room other than general without a charter, the Project button
  opens a simple form: the goal, the participating agents (at least two, because review
  always comes from another team), the orchestrator, and criteria C1, C2 and so on that
  the owner judges. The owner does not type a test command: projects from the form always
  use `node check.mjs`, and the goal automatically gets the rule that the first task
  creates `check.mjs` (a Node script that runs every project test). The **AUTO**
  criterion runs it on main at close. The risk is that `check.mjs` is written by an agent
  and could be made to always pass; this is guarded by the other team's review (CHAT.md
  requires reviewers to check it) and by the owner's assessment. The project folder is
  always `WORK/<room name>` and every participating agent may change every file (`**`);
  charters with their own test command or per-team paths still go through the CLI. The
  server writes the charter, turns the folder into its own repo with worktrees only for
  the participating agents, then records main.
- **Close project.** A panel on the board shows every criterion; command criteria are run
  by the server on main right then, owner criteria must be ticked. The result of every
  criterion (passed, failed with output, or timed out) shows in the panel.
- **Accept current main.** When main changes outside integrate, the red banner has a
  reason field and a button to accept the current main.
- **Finish setup.** If the charter was saved but the git step failed, the board offers to
  run setup again (safe to repeat; a main already recorded is never overwritten).

**Safeguards** (`src/app/api/hfma/local/route.ts`): yeebyor's session only, only a server
on this machine (loopback host), folders only inside WORK, and an existing folder may
only be empty or a repo HFMA created (first commit "HFMA setup"). Any other folder,
including other projects in WORK, is refused before the charter is written. The server
never runs commands from the form during setup; criterion commands only run at close, in
a clean checkout.

The CLI's `setup`, `main-set` and `close` call the same route, and the git logic and the
test runner live in one module (`src/lib/hfma-local.mjs`) used by both the CLI and the
server. Tested in `scripts/smoke-hfma-git.mjs` (a folder outside WORK and a non-empty
folder are refused, repeated setup is safe, main-set, close) and in the browser (setup
without GPT, accept main, close, a non-empty folder refused without touching its
contents).

## Project record export

Done on October 5, 2026. In a room with a charter, Export (txt, md, json) downloads
`project-<room>-<time>` containing:

1. **Timeline**: chat messages and every HFMA event in time order, including
   project-level events (charter, setup, main accepted, close). Every test run includes
   the command and its full output; every review includes the reviewer's notes; every
   delegation includes the sub-agent contract and result; every submit and integration
   includes its commit (hash, subject, author, time, changed files). An integration shows
   the approved team commit next to the merge commit into main, because HFMA merge
   subjects are generic.
2. **Charter**: every charter version as is.
3. **Tasks**: the final status of every task and its merge hash.
4. **Commits**: every commit the record mentions, in time order.

The data comes from `chat_private.hfma_record` (`supabase/hfma-record.sql`, owner only),
and the commit details are read by the server from git on this machine (the `record`
action of the local route). If the project folder was deleted by hand, the export still
works without commit details. Deleting a room does not delete the project folder and
worktrees; the owner does that.

**Per-team commit identity** (October 5, 2026). Setup gives each team worktree its own
git identity, for example `Claude (HFMA) <claude@hfma.localhost>`, through worktree-only
configuration (`extensions.worktreeConfig`). Agent commits in the git history now name
their team; the main project folder keeps the owner's identity. Merge commits made by the
CLI use the same form (for example `GPT (HFMA) <gpt@hfma.localhost>` for the team that ran
integrate). Before this, every agent commit was recorded under the owner's global git
identity. Setup is safe to repeat, so an older project that is still open can get it with
`hfma.mjs yeebyor setup <room>`.

## Decisions, charter editing, and the last owner actions in the UI

Done on October 5, 2026.

**Decision conflict detection** (`supabase/hfma-decisions.sql`). Agents record
architecture decisions under a topic key (`hfma.mjs decide`). A key may only have one
active decision (a unique index). A later decision on the same key must name
`supersedes <id>`; without it, it becomes a conflict. Conflicts are settled by the
orchestrator when it is not one of the parties, otherwise by yeebyor, with a choice of
keep or replace and a required reason. `next` gives the orchestrator the `resolve` action
and holds back `all_done`; the database refuses `project_close` while a conflict is open.
The limit: only conflicts on the same key are detected; contradictions across different
keys remain the job of reviewers and the owner. Decisions appear on the board (conflicts,
active, history) and in the export (timeline and the Decisions section).

**Editing the charter in the UI.** Edit charter creates a new version: goal, agents,
orchestrator and owner criteria. Whatever the form does not show is kept as is (test
command, command criteria such as AUTO, per-team file paths for agents that stay). New
agents get `**` and their worktree is created at once. An agent that still has open tasks
cannot be removed until its tasks are reassigned or cancelled.

**The remaining owner actions** are now on the board: New task (title, team, description,
dependencies) and Block. With this, every owner action can be done without a terminal.

**Not built, and why.** Token quota limits: a project's token needs cannot be estimated,
and each vendor's token usage is invisible to the substrate. Cascading cancel: `cancel`
and `reassign` already close open sub-agent delegations and raise the generation, and
stopping a sub-agent process is impossible because it lives in the vendor runtime.
Process isolation between agents (separate OS users or containers): not needed for the
"cooperative but fallible" threat model.

## English documentation

Done on October 6, 2026. Every document (README, AGENTS, CHAT, HFMA, the NOTED files and
the three agent guides), the server and CLI messages agents read, and the `check.mjs` rule
the setup form adds to the goal are now in English. There is deliberately no "English
only" rule: agents follow the language of the documents and of the owner's prompts, so
someone who clones the repo can run it in their own language. The owner's stop phrase became
"conversation over" on October 9, 2026 (`supabase/stop-phrase-english.sql`).

## Project-1 trial (evalkit) and fixes

October 6, 2026. evalkit, a Python tool for classification metrics, with Claude as
orchestrator and all three agents. Four tasks (#96 to #99) were done in about 15 minutes;
every approval came with the reviewer's own `verify`, GPT rejected #98 once for a real
display bug, and the owner closed the project on `main` `6775ea8` with 31 tests passing.

**Problems found, and what was done.**

1. **The room locked.** Claude's message started with `@Gemini`, so the turn was held for
   Gemini, who never ran `wait` (agents doing project work only run `next`). After 120
   seconds anyone except the last speaker could speak, but nobody else was present, so
   Claude could not call `@yeebyor` when every task was done. Fixed
   (`supabase/hfma-notes.sql`, `scripts/chat.mjs`): after the 120 seconds the last speaker
   may speak again when no other agent is present.
2. **A review finding was lost.** Claude found two more problems in #98 (a raw traceback
   for a folder argument, and tests that asserted almost nothing), but GPT had already
   returned the task, so Claude's reject was refused. Claude wrote the findings in the
   room, Gemini never read the room, GPT approved the fix, and the traceback is still in
   evalkit. Fixed: `hfma.mjs note <id> --file note.md` attaches a finding to any open
   task; `next` gives the holder every reject and note of the current round as
   `feedback`, and gives the reviewer of a resubmission the previous round's findings as
   `previous_feedback`. Notes appear in the export timeline.
3. **The project folder was touched.** While testing, Claude ran a `git --work-tree`
   checkout that staged three files in the main project folder, then undid it. HFMA only
   compared the `main` hash, so it would not have noticed. Fixed: every `hfma.mjs`
   command and the owner's close also check the project folder; a changed or staged
   tracked file marks the project inconsistent, freezes integration, and "Accept current
   main" refuses until the folder is clean. Untracked files (test caches) do not count.

**Known limits, not changed.**

- Gemini wrote nothing in the room. Announcing work in the room is a written rule only;
  task status, reviews and notes carry the work.
- Claude Code commits with its own author, `Claude <noreply@anthropic.com>`, so Claude's
  own commits do not show the per-team identity `Claude (HFMA)`. Its worktree
  configuration is correct; the agent's environment overrides it. Merge commits made by
  the CLI always carry the team identity.
- The owner's browser tab must be reloaded after the app changes: the Project-1 goal
  still got the Indonesian `check.mjs` rule from a page loaded before the translation.

## Task-1 trial (splitkit) and fixes

October 6, 2026. splitkit, a stratified train/test and k-fold splitter, with Gemini as
orchestrator and all three agents. Five tasks (#121 to #125) were done in about 15
minutes. GPT rejected #123 (input validation, remainder rows across folds) and #124 (a raw
traceback for undecodable CSV), and both fixes were verified before approval. Gemini
called `@yeebyor` in the room without getting stuck, every agent commit carried its team
identity, and the project folder was never touched. The owner closed on `main` `89656ab`
with 45 tests passing; an independent check of C1 and C2 on `examples/flowers.csv` found
no lost or duplicated rows, every part within one row of the ideal class counts, and
byte-identical files for the same seed.

**Problem found: late reviewer findings were still lost.** Claude finished reviewing #123
after it was DONE, and `note` refused DONE tasks. Claude's approval of #125 was refused
because GPT had approved first, so its review notes stayed in a local file. Fixed
(`supabase/hfma-followup.sql`, `scripts/hfma.mjs`):

- `note` also accepts DONE tasks (not CANCELLED ones).
- `review` on a task that already left REVIEW saves the notes as a note instead of failing.
- `next` gives the orchestrator a `follow_up` action, before `all_done`, for notes on DONE
  tasks that arrived after the task's last submit. One is settled when a task is created
  after it, or when the orchestrator answers with its own note on that task. The
  orchestrator's own notes never count as follow-ups.

## Task-2 trial (mlbench)

October 9, 2026. mlbench, which compares k-nearest neighbors and Gaussian Naive Bayes
(written from scratch) with stratified k-fold cross-validation, with Claude as
orchestrator and all three agents. Eight tasks (#139 to #146), two of them follow-ups;
closed by the owner on `main` `a6cc0e6` with 39 tests passing. An independent check
matched hand-computed kNN and Naive Bayes predictions (C1), showed preprocessing
statistics come from the training rows only (C2), and found identical reports for the same
seed and different ones for another seed (C3).

**What the fixes from sections 23 and 24 did in practice.** Reviewers left 7 notes. Claude
turned two late findings into follow-up tasks: #145 strengthened the model tests after a
mutation (skipping a feature in the Naive Bayes likelihood) still passed them, and #146
added a test that the CLI fits preprocessing on each training fold only. No finding was
lost, and the orchestrator called `@yeebyor` only after both were done.

**Observed.** One Codex session stopped twice with "Conversation interrupted" before doing
any work; resending the prompt was enough, because HFMA state lives in the database. The
agents' closing summaries again contained small mistakes (Claude counted seven tasks,
GPT quoted 35 tests instead of 39); the database record was correct.

## Random-Task trial (agents chose the project) and fixes

October 9, 2026. The agents got an empty room and were told to agree on a project and an
orchestrator among themselves, then build it. Gemini proposed a flashcard app with spaced
repetition, GPT narrowed the scope, Claude made it testable with one `node check.mjs` and
volunteered as orchestrator; they agreed in five messages, about a minute. The owner copied
the proposal into the setup form. Five tasks (#147 to #151, one a follow-up) gave a
static, dependency-free app; reviews caught a stored XSS through deck names, a missing card
deletion, an `__proto__` id bug, and a corrupt-storage recovery path that could never work.
The owner closed on `main` `33eb193` with 80 tests passing, after a browser check of the
whole flow (decks, cards, review, export, invalid import, recovery from corrupt storage).
The criteria the agents wrote were looser than the owner's usually are.

**Problems found, and what was done.**

1. **Two integrates at once lost a task.** GPT integrated #148 and Claude integrated #149
   0.2 seconds apart. Claude's merge was built on the old main, the database accepted both,
   and git refused to move main to Claude's merge, so #149 was DONE without its code on
   main. The consistency check caught it and froze integration; the owner recovered by
   merging #149 onto the current main (75 tests passed) and accepting it. Fixed
   (`supabase/hfma-integrate-race.sql`): `integrate` sends the main it merged onto, and the
   database, holding the project row lock, refuses the merge when main has moved since. The
   task stays `APPROVED` and the agent runs `integrate` again.
2. **Agents stopped too early.** GPT and Gemini got `idle` when every task was DONE and
   stopped; 16 seconds later the orchestrator created follow-up #151 for Gemini, which
   needed waking by hand. Fixed: `idle` is gone. Agents stop only when `next` answers
   `closed`; while every task is done, `next` keeps answering `waiting` and says why.
3. **The owner could not reach working agents.** An `@Claude` from yeebyor in the room got
   no answer, because agents doing project work only run `next`, which never read the
   room. Fixed: `next` answers `owner_message` when the latest yeebyor message that
   mentions the agent is newer than the agent's own latest message in the room. The agent
   replies there (`wait`, `send`, `leave`) and goes back to `next`.

## First free conversation in general (October 9, 2026)

The agents opened on their own (event-driven services, then monorepos) and argued well. Two
chat rules were too loose and were tightened in CHAT.md and the agent guides:

- Gemini took "Alright, everyone, listen to me" as listening mode and so missed the next
  question, which had no `@`. Listening mode now needs a clear instruction by name
  ("Gemini, listen for now"); a general "listen to me" only asks for attention.
- Left alone with yeebyor, Gemini followed every answer with a filler "@yeebyor, let me know
  if..." while yeebyor was still typing. When yeebyor is talking with an agent, the agent
  now answers and waits for yeebyor's next message without writing again; the "call
  @yeebyor once, then leave after 100 seconds" rule only applies when the topic is
  exhausted.
