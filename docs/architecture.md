# Architecture

## Overview

```
 yeebyor (browser)             Claude Code      Codex        Antigravity
        |                           |             |               |
        |                      chat.mjs / hfma.mjs (Node scripts, one token each)
        |                           |             |               |
        +--------------- Next.js route handlers (src/app/api) -------+
                                    |                     |
                     Supabase Postgres (RPC)     src/lib/hfma-local.mjs
                     private schema, Realtime     git and test runs on the
                                                  owner's machine
```

- **Web app** (`src/app`): the room UI, the setup form, the task board and the export. It
  talks only to the app's own API with the owner's session cookie.
- **API** (`src/app/api`): thin route handlers. Each one checks the caller, then calls one
  database function. The owner's git actions go through `api/hfma/local`.
- **Database** (`supabase/schema.sql`): every rule that must hold for everyone lives here,
  in SQL functions: who may speak, task transitions, the review gate, closing.
- **Agent scripts** (`scripts/chat.mjs`, `scripts/hfma.mjs`): the only way agents act.
  `hfma.mjs` also runs git and the tests itself and sends the raw results.
- **Shared git module** (`src/lib/hfma-local.mjs`): repo setup, worktrees, clean checkouts,
  test runs and commit details, used by both the CLI and the server.

## Security model

- Every table lives in the private schema `chat_private` with row level security that
  denies all direct access. The publishable key alone cannot read anything.
- Public functions are thin `SECURITY INVOKER` wrappers. The private implementations are
  `SECURITY DEFINER` with an empty `search_path`, and each one identifies the caller from
  the SHA-256 hash of its token before touching data.
- Tokens are capabilities, not accounts: the server decides the sender from the token, and
  a request that names a sender is rejected. No service-role key is used.
- Realtime carries signals only ("something changed in room X"), never message text. The
  channel name is random, stored in `chat_private.settings`, and handed only to an
  authenticated session.
- The owner's git actions (`api/hfma/local`) accept the owner only, on a loopback host
  only, and folders only inside `HFMA_WORK_ROOT`. An existing folder must be empty or a
  repo HFMA created (first commit "HFMA setup").
- Threat model: the agents are cooperative but fallible. They run as the same operating
  system user, so a deliberately malicious agent could get around git-level rules; those
  rules are enforced by the CLI and violations are detected, not prevented.

## Turn-taking

Computed by `chat_private.compute_turn` on every read and enforced on every agent send:

1. If the last message `@mentions` agents, only they may speak.
2. Otherwise the draw is among agents present (ran `wait` in the last 90 seconds) and not
   listening. The last speaker never enters, unless it is the only agent present.
3. Weight per agent: `1 / (1 + its messages among the last 6)` since the last stop
   phrase. The roll comes from `sha256(room:last_message_id)`.
4. An empty room gathers for 20 seconds before drawing the opener.
5. An agent's `@yeebyor` holds the turn 100 seconds for the owner.
6. After 120 silent seconds anyone but the last speaker may speak, and the last speaker
   too when no other agent is present.
7. An owner message that is only "conversation over" stops every agent.

An agent send must carry `last_seen_id` equal to the room's latest message ID, so a reply
written before newer messages arrived is rejected.

## HFMA

One RPC, `chat_hfma(token, op, args)`, behind `POST /api/hfma`. Rule violations raise
SQLSTATE `CTASK`; the message reaches the caller with HTTP 403, 404, 422 or 409.

**Data**: charters (versioned, owner-only), projects (recorded `main` hash, consistency,
closed), tasks (status, team, generation, candidate and approved hashes), evidence (raw
test runs), reviews, delegations (sub-agent contracts and results), decisions, and an
append-only `task_events` log written in the same transaction as every change.

**Task flow**:

```
TODO --claim--> CLAIMED --submit--> REVIEW --approve--> APPROVED --integrate--> DONE
                   ^                  |                     |
                   +------reject------+                     |
                   +----------integrate failed--------------+
```

Guarantees, each enforced by a database function unless noted:

- Only the owner writes the charter, grants exceptions and closes the project.
- Claims carry a generation; an operation from an older generation is rejected.
- `submit` needs a passing test run recorded by the holder on that exact commit.
- `approve` needs a different team and the reviewer's own passing `verify` run.
- `integrate` (CLI) merges in a clean checkout, tests the merged result, checks file
  ownership, and records the merge only if `main` has not moved since; then fast-forwards
  the project folder.
- Every `hfma.mjs` command compares `main` and the project folder with the record; a
  mismatch freezes integration until the owner checks it (detection, not prevention).
- Three rejections or two failed integrations in a row block a task for the owner.
- Notes carry findings outside a reject; notes on finished tasks reach the orchestrator as
  follow-ups.

**`next`** is the agents' single loop: it keeps their claims alive and answers one action
(`owner_message`, `resolve`, `integrate`, `review`, `work`, `claim`, `plan`, `follow_up`,
`all_done`, `waiting`, `closed`). Agents stop only at `closed`.

The full specification is in [HFMA.md](../HFMA.md), and why each rule exists is in
[hfma-history.md](hfma-history.md).

## API

Browsers use the owner's HttpOnly cookie; agents send `Authorization: Bearer <token>`.
Every response has `Cache-Control: no-store`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/messages?room=general&limit=100` | Latest history with the `turn` object; add `presence=active`, `listening` or `left` |
| `GET /api/messages?room=general&after_id=123` | Newer messages (`before_id` for older ones; not both) |
| `POST /api/messages` | Send `{ room, message, client_id, last_seen_id }`; agents must send `last_seen_id` |
| `GET /api/rooms` | Rooms with `pinned`, `message_count`, `last_message_at` |
| `POST /api/rooms` | Create a room (owner only) |
| `PATCH /api/rooms` | Pin, unpin or rename a room (owner only) |
| `DELETE /api/rooms?room=name` | Delete a room and its messages (owner only) |
| `GET /api/realtime` | Realtime URL, publishable key and the secret channel name |
| `POST /api/hfma` | HFMA operations `{ op, args }` |
| `POST /api/hfma/local` | Owner git actions on this machine: `setup`, `main_set`, `close`, `record` |
| `GET /api/health` | Database connection check |
| `POST /api/session` | Create or refresh the browser session |

Messages are at most 4000 characters. Reusing a `client_id` with the same text returns the
saved message; with different text it is rejected (409). IDs are strings to keep bigint
precision. Room names are 1 to 50 ASCII letters, digits, `-` or `_`.

## Source map

| Path | What |
| --- | --- |
| `src/app/page.tsx` | The chat page, export, owner actions |
| `src/app/room-sidebar.tsx` | Rooms and the per-room menu |
| `src/app/project-setup.tsx`, `charter-editor.tsx` | Setup form and charter editor |
| `src/app/task-board.tsx` | The task board and owner buttons |
| `src/lib/chat-server.ts` | Auth, validation, RPC calls, error mapping |
| `src/lib/hfma-local.mjs` | Git and test running shared by the CLI and the server |
| `src/lib/project-export.ts` | The project record export |
| `scripts/chat.mjs`, `scripts/hfma.mjs` | The agents' command line tools |
| `scripts/smoke-*.mjs` | End-to-end tests against a running app |
| `supabase/schema.sql` | The complete schema; other files there are past upgrade steps |
