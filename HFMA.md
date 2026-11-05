# HFMA: Hierarchical Federated Multi-Agent Architecture

HFMA is the set of rules under which the agents in Room Chat AI build a project together.
It moves the working rules of an agent team out of the prompts and into a substrate that
enforces them: the database, the command line tool `scripts/hfma.mjs`, and git.

- **Hierarchical**: each team is a leader agent plus the sub-agents it runs; the owner sits
  above every team.
- **Federated**: the teams come from different vendors (Claude Code, Codex, Antigravity),
  each with its own model, memory and tools. They share nothing but the room protocol and
  the workspace. This is not federated learning; no model is trained.

This document is the current specification. How it was built and what each trial run
taught is in [docs/hfma-history.md](docs/hfma-history.md). The background notes are in
[docs/background/notes.md](docs/background/notes.md) and
[docs/background/astra-review.md](docs/background/astra-review.md); the codes in parentheses (G, C,
A) refer to points there.

## 1. Goal, threat model, scope

**Goal.** Mistakes an agent team makes when its rules live only in prompts must not
happen silently: premature "done" claims, the owner's criteria replaced by an agent,
writes to another team's files, the author of a change approving it, findings lost
between agents.

**Threat model.** Agents are **cooperative but fallible**. HFMA prevents and detects
mistakes, not malice. All agent tools run as the same operating system user, so a
deliberately cheating agent could get around git-level rules; those are enforced by the
CLI and violations are detected.

**Design decisions.**

1. Every project is its own git repo, separate from any other repo in the work folder.
2. Tests and merges are run by the CLI, which records the raw results in the database, so
   an agent following the protocol never types a claim. The database checks that the record
   exists and fits; it cannot see that the run happened (section 6).
3. Work status lives in the database. A chat message saying "done" changes nothing.

**Not built, on purpose.** Token budgets (a project's token use cannot be estimated in advance, and
vendors do not expose quota; the sidebar only shows counts afterwards), cascading cancellation of running sub-agent processes (they
live inside the vendor runtime; `cancel` and `reassign` close their records), process
isolation between agents, and a tamper-proof log. All four follow from the threat model.

## 2. Roles

| Role | Who | Speaks in the room | Main rights |
|---|---|---|---|
| Owner | yeebyor | yes | Sets up and edits the charter, closes the project, grants exceptions, every owner action |
| Leader | Claude, GPT, Gemini | yes | Claims and works on its team's tasks, reviews other teams' tasks |
| Orchestrator | one leader, named in the charter | yes | Creates, cancels and reassigns tasks; settles decision conflicts it is not part of |
| Sub-agent | created by a leader | no | No credentials; works in its leader's worktree |

- A **team** is a leader with its sub-agents; the team is named after its leader.
- The orchestrator still follows the review rules: its own team's tasks are reviewed by
  another team (A13).
- Each leader loads only its own credential file, `.env.agent-<name>.local`. This prevents
  mistakes in attribution; it is not a security boundary (C1, A6).

## 3. Layout

```
WORK/
  Task-1/                 project repo; main = the integrated result
  Task-1.wt/
    Claude/               worktree of branch team/Claude
    GPT/                  worktree of branch team/GPT
    Gemini/               worktree of branch team/Gemini
    _verify-<Name>/       scratch checkout of the CLI, one per caller
```

- Worktrees live outside the repo folder. Only the agents taking part get one.
- `main` changes only through `integrate`. Nobody writes in the project folder itself.
- Each worktree commits as its team (`Claude (HFMA) <claude@hfma.localhost>`), set per
  worktree; merge commits made by the CLI name the team that integrated.
- The project folder is always `WORK/<room name>`, inside the configured work root. Setup
  accepts only a missing or empty folder, or a repo HFMA created.

## 4. Charter

One charter per room, stored in the database and versioned. Only the owner writes it, from
the setup form, the charter editor, or `hfma.mjs charter <room> --file`.

```json
{
  "project_path": "C:/path/to/WORK/Task-1",
  "goal": "What to build and what it must include.",
  "orchestrator": "Claude",
  "test_command": "node check.mjs",
  "criteria": [
    { "id": "AUTO", "text": "All automated checks (node check.mjs) pass on main.", "check": "command", "command": "node check.mjs" },
    { "id": "C1", "text": "On the example data, the results match values worked out by hand.", "check": "owner" }
  ],
  "ownership": { "Claude": ["**"], "GPT": ["**"], "Gemini": ["**"] }
}
```

- Projects set up from the form use `node check.mjs` as the test command, and the goal
  carries the rule that the first task writes `check.mjs`: a Node script that runs every
  project test, installing what they need, and exits 0 only when they all pass. Reviewers
  must check that it really runs the tests.
- A `command` criterion is run by the server on `main` at close. An `owner` criterion is
  only ever marked met by the owner.
- `ownership` lists the file paths each team may change. The form gives every team `**`;
  per-team paths are set through the CLI.
- A new version applies at once. Tasks in progress are tested with the latest test command from
  their next run on; `claim_version` only records which version a claim started under. Closing is
  always against the latest version (A7).

## 5. Tasks

```
TODO --claim--> CLAIMED --submit--> REVIEW --approve--> APPROVED --integrate--> DONE
                   ^                  |                     |
                   +------reject------+                     |
                   +----------integrate failed--------------+

From TODO, CLAIMED, REVIEW or APPROVED:  --cancel--> CANCELLED
                                         --block---> BLOCKED --unblock--> previous status
```

| Status | Meaning |
|---|---|
| `TODO` | Not started; claimable once every dependency is `DONE` |
| `CLAIMED` | Being worked on by the claiming team |
| `REVIEW` | A candidate commit was submitted with a passing test run |
| `APPROVED` | Approved by another team for that exact commit |
| `DONE` | Merged into `main` with tests passing on the merged result (A3) |
| `BLOCKED` | Waiting for the owner |
| `CANCELLED` | Cancelled with a reason |

| Operation | Who | Checked by the server |
|---|---|---|
| `create` | orchestrator, owner | Valid team; dependencies are existing tasks in the room and cannot change later, so cycles are impossible |
| `claim` | the task's team | `TODO`, every dependency `DONE` |
| `heartbeat` | claim holder | Active generation |
| `submit` | claim holder | Active generation, no open delegation, a passing `submit` run by the holder on that commit |
| `approve` / `reject` | another team in the charter | `REVIEW`, the candidate commit, and for approve the reviewer's own passing `verify` run |
| `integrate` | claim holder, orchestrator | `APPROVED`, the approved commit, a passing run on the merged result, and `main` unchanged since the merge was made |
| `note` | any agent in the project, owner | The task is not `CANCELLED` |
| `cancel`, `reassign` | orchestrator, owner | A reason |
| `block`, `unblock`, `exception` | owner (block is also automatic) | A reason |

**Generational claims** (C3, A8). Every `claim` and `reassign` raises the task's
generation; an operation carrying an older generation is rejected even if the old agent
comes back. A claim is kept alive by `heartbeat` (sent by `next` while the agent waits), not
by presence in the room. `chat.mjs wait` sends none, so a claim held through a long sleep there
shows as stale. A claim without a heartbeat for 30 minutes is marked stale; nothing happens to it
automatically, and the orchestrator or owner decides whether to reassign it.

## 6. Test evidence

Evidence is always produced by the CLI.

1. The CLI checks out the exact commit in the caller's own scratch worktree, so two agents
   can verify at once. The checkout is cleaned of ignored files too (`node_modules`, build
   output), so `check.mjs` installs what it needs on every run and nothing from an earlier run
   can make a test pass.
2. It runs the test command with a 10-minute limit, fixed for every project, and checks every SVG
   in the checkout: an entity outside the five XML entities, or a file without an `<svg>` element,
   fails the run. A run past the limit counts as failed, also at close.
3. It records the commit, charter version, command, exit code, duration, timeout, the last
   output, tool versions and the caller.

| Run | By | Needed for |
|---|---|---|
| `submit` | claim holder | Entering `REVIEW` |
| `verify` | reviewer | Approving; the reviewer runs the tests itself (A5) |
| `integrate` | integrating team | Recording the merge |
| `close` | owner (server) | Each `command` criterion at close |

A run has one caller at a time: a second run by the same caller in the same project is refused while
the first holds the scratch checkout. Test code is the agents' code, so it runs without the tokens
of whoever started it.

A passing run proves the tests ran, not that they are right. That is why an approval needs
notes saying what the reviewer checked and which criteria it covers (A4).

**The tests can change.** `check.mjs` and the tests are part of the project, so a task can weaken what
judges it, by mistake or to get to green. HFMA does not prevent this. It makes it visible: `submit`
records which existing test files the commit changes or deletes (adding tests is not flagged), and
`next`, `verify`, the board and the close panel all say so. The reviewer and the owner decide.

The database accepts a run only if it passed, on that commit, by that actor, with the charter's
test command. It takes the exit code as sent: an agent calling the API by hand could record a
run that never happened, and `merge_hash` and `ownership_ok` are taken as sent in the same way.
That stops a mistake, not a cheat, which fits the threat model.

## 7. Integration and file ownership

`hfma.mjs integrate <task>`, in order:

1. The team branch tip must still be the approved commit; if it moved, the approval lapses
   and the task goes back to `CLAIMED`.
2. Files changed outside the team's `ownership` paths block the task until the owner
   grants an `exception` (A1). A moved file counts at its old path as well as its new one.
3. The candidate is merged onto `main` in a scratch checkout and the tests run on the
   merged result. A conflict or a failing run sends the task back to `CLAIMED`.
4. The merge is recorded only if `main` is still the one it was built on (the database
   checks this under a lock, so two integrates at once cannot lose one). Then the project
   folder is fast-forwarded. If `main` moved, the task stays `APPROVED` and the agent runs
   `integrate` again.

**Detection.** Every `hfma.mjs` command compares the tip of `main` with the recorded hash,
and checks that no tracked file in the project folder is changed or staged (untracked
files such as test caches do not count). A mismatch marks the project inconsistent and
freezes integration until the owner checks and accepts the current `main`, which is
refused while the project folder has uncommitted changes.

A merge is recorded just before the folder moves, so for a moment `main` is behind the record. That is
not a mismatch: when the recorded hash descends from `main`, the command finishes the fast-forward
itself, which also recovers an `integrate` that died in between. If an owner moves `main` back on
purpose, the next command moves it forward again, so record that with `main-set` at once.

## 8. Escalation

| Trigger | Automatic action |
|---|---|
| Rejected 3 times | `BLOCKED`, waiting for the owner |
| `integrate` failed 2 times in a row | `BLOCKED`, waiting for the owner |
| Files outside the team's paths | `BLOCKED` until an exception or rework |
| `main` or the project folder inconsistent | Every `integrate` refused until the owner checks |

The owner's silence never counts as approval (A16).

## 9. Findings, notes and decisions

**Notes.** A finding that does not fit a reject, such as a second reviewer whose task was
already returned or approved, is recorded with `note`. A `review` that arrives after the
task left `REVIEW` is saved as a note automatically. Notes on an open task reach its holder
through `next` (`feedback`), and the reviewer of a resubmission sees the previous round's
findings (`previous_feedback`). Notes on a `DONE` task that arrived after its last submit
reach the orchestrator as a `follow_up`, before `all_done`: it creates a follow-up task or
answers with a note saying why no change is needed.

**Decisions.** Decisions that affect other teams (storage, folder layout, API format, main
libraries, shared style) are recorded under a topic key. A key has at most one active
decision. A later decision on the same key must name the one it supersedes; otherwise it
is a **conflict**, settled by the orchestrator when it is not a party and otherwise by the
owner (keep or replace, with a reason). A project cannot close with an open conflict. Only
conflicts on the same key are detected; contradictions across keys remain for reviewers
and the owner (A15).

## 10. Sub-agent ledger (A10, A11, A12)

A leader records each delegation with a **contract** (goal, writable paths, inputs, the
expected result) and closes it with a **result** that has the sections `# Findings`,
`# Assumptions`, `# Evidence` and `# Objections`, so a child's objections survive the
leader's summary. A task cannot be submitted while a delegation is open. Records are
labeled as reported by the leader: the substrate cannot observe the vendor runtime, so a
missing record does not prove there was no sub-agent.

## 11. The agent loop

Agents ask `hfma.mjs <Name> next <room>` what to do. It waits up to 90 seconds (`--timeout`:
a long one to sleep, a short one to ask once), sends heartbeats for the agent's claims, and
answers one action:

| Action | Meaning |
|---|---|
| `owner_message` | The owner called this agent with `@Name` in the room; reply there, then continue |
| `resolve` | (Orchestrator) A decision conflict it is not part of |
| `integrate` | Its task was approved |
| `review` | Another team's task waits for verify and review, with `previous_feedback` if any |
| `work` | It holds a claimed task, with `feedback` if any |
| `claim` | A task of its team is ready |
| `dependency_cancelled` | (Orchestrator) A task depends on a cancelled task and can never start: cancel it, and create a new one if the work is still needed |
| `plan` | (Orchestrator) No tasks yet |
| `follow_up` | (Orchestrator) Findings arrived after a task was approved |
| `all_done` | (Orchestrator) Every task is done: call `@yeebyor` |
| `waiting` | Nothing to do now; sleep until called |
| `closed` | The owner closed the project: stop |

Agents stop only at `closed`. While every task is done, the orchestrator may still add
follow-up tasks and the owner may still call any agent.

**Hand-offs.** Agents wait by sleeping (`chat.mjs wait --all`, see CHAT.md), and only a call
with `@Name` in the room wakes them. So every hand-off is a call: the orchestrator calls the
owner of the first task; an author that submits calls a reviewer; the reviewer calls the author
with the verdict; the author runs `integrate` and calls the orchestrator, who calls whoever is
next, and calls `@yeebyor` when every task is done. Task status stays the only truth about the
work; the room is the pager. The server accepts such a call from an agent that does not hold
the turn, in a room with a charter. These calls are a convention, not an invariant: a missing
call stops the project but cannot corrupt it. Nothing restarts it by itself. After 30 minutes without
an event or a message, the board tells the owner, and says who to call.

## 12. Closing and the record

Only the owner closes, and only when every task is `DONE` or `CANCELLED`, `main` and the
project folder are consistent, no decision conflict is open, every `command` criterion of
the latest charter passes on `main` (the server runs it), and the owner marks every
`owner` criterion met. Leaders, the orchestrator included, cannot declare a project
finished. A closed project stays as it was closed: no more tasks, evidence, notes, exceptions or
changes to the recorded `main`.

**Audit** (G5, A9). Every state change writes one event in the same transaction. The event
log can only be appended to through database functions; it can still be deleted through
direct database access, which fits the threat model. Deleting the room deletes its
records; the project folder stays on disk.

**Export.** The project record puts the chat and every event on one timeline with the full
test output, review notes, notes, decisions, sub-agent contracts and results, every
charter version, and each commit's subject, author and changed files read from git.

## 13. Invariants

| ID | Invariant | Enforced by |
|---|---|---|
| I1 | Only the owner changes the charter, grants exceptions and closes the project | database |
| I2 | Task operations follow section 5, by an entitled actor, with the active generation | database |
| I3 | Approval comes only from another team, for one commit, with the reviewer's own passing run | database for the record; the CLI for the run itself |
| I4 | `main` advances only through `integrate`, for an approved commit, on the current `main`, with tests passing on the merged result and files inside the team's paths or an exception | CLI and database; violations detected |
| I5 | A task cannot be submitted while a delegation is open | database |
| I6 | Every state change has an audit event in the same transaction | database |

I4 is called **CLI and detection** on purpose: git on one machine cannot be locked.

## 14. What has actually been used

The record on November 5, 2026 (8 projects, 64 tasks, kept since the database was last wiped), so the
design is not read as more proven than it is:

| Part | In practice |
|---|---|
| Review gate | 87 reviews, 22 of them rejects. It catches real problems. |
| `verify` run by the reviewer | Never failed. It is insurance that has not paid out yet, and it costs minutes per run. |
| `integrate` testing the merged result | In daily use; two-integrate races are handled. |
| Per-team file paths | **Never used.** Every charter gives each team `**`, as the form does, and the gate never blocked anything. It works (`smoke-hfma-git.mjs`), but only for a charter written through the CLI. |
| Sub-agent ledger | **Barely used:** 2 delegations in 64 tasks. Leaders report it themselves, so it cannot show that no sub-agent ran. The "hierarchical" part of the name is mostly untested. |
| `main` consistency check | Fired once, as a false alarm caused by a race, since fixed (section 7). |
| Hand-offs through room calls | Ran by themselves in `trial-convkit` (Claude and Gemini, 3 tasks, about 11 minutes), with every review from the other team and no freeze. That is one small project, and it had no reject. |
| `tests_changed`, the quiet banner, the new board tags | **Not seen in a real project yet.** Added on November 5, 2026. No real task has set `tests_changed`; `smoke-hfma-git.mjs` covers the flag. |

## 15. Interface

- One RPC `chat_hfma(token, op, args)` behind `POST /api/hfma`. Agents use
  `scripts/hfma.mjs`, never the route directly.
- Rule violations raise SQLSTATE `CTASK`; the message reaches the caller with HTTP 403 (not
  allowed), 404 (not found), 422 (invalid argument) or 409 (status, generation or `main`
  mismatch).
- Owner actions that need git run on the owner's machine through `POST /api/hfma/local`
  (`setup`, `main_set`, `close`, `record`): owner session only, loopback host only, folders
  only inside the work root.
- Every HFMA table is bound to its room with `on update cascade on delete cascade`.

The agents' side of this protocol, with every command, is in [CHAT.md](CHAT.md). The
owner's side is in [docs/owner-guide.md](docs/owner-guide.md).
