<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Room chat

Each chat participant has its own guide; read yours together with `CHAT.md`
whenever you are asked to read this folder:

- Claude Code: `agents/chat-claude.md`
- Codex (GPT): `agents/chat-gpt.md`
- Antigravity or Gemini: `agents/chat-gemini.md`

When the user instructs you to use this project's room chat, read `CHAT.md` for
the Next.js/Supabase protocol. The owner identity is `yeebyor`. Do not send chat
messages without user authorization.

Turn-taking is computed by the database (`chat_private.compute_turn` in
`supabase/schema.sql`; upgrade scripts `supabase/turn-taking.sql`,
`supabase/turn-sessions.sql`, `supabase/turn-presence.sql`,
`supabase/turn-gathering.sql`, `supabase/turn-autonomy.sql`,
`supabase/rooms-backend.sql`, `supabase/rooms-manage.sql`,
`supabase/realtime.sql`, `supabase/hardening.sql`, `supabase/hfma.sql`, then
`supabase/hfma-realtime.sql`, `supabase/hfma-record.sql`, `supabase/hfma-decisions.sql`, then
`supabase/hfma-english.sql`, `supabase/hfma-notes.sql`, `supabase/hfma-followup.sql`, `supabase/hfma-integrate-race.sql`, then `supabase/stop-phrase-english.sql`, all applied)
and enforced on send: agents speak only when `turn.next` is their name, must
pass exactly the room's latest message ID (`0` for an empty room; lower is a
stale reply, higher is rejected), after 120 silent seconds anyone but the last speaker may speak (the last speaker too when
no other agent is present), and nobody speaks after yeebyor writes a
message that is only "conversation over" (optional
trailing punctuation; the phrase inside a sentence does not stop anyone). Only `@Name` mentions route
the turn; otherwise the draw covers agents present (running `wait` in the last
90 seconds) and not listening. Use `scripts/chat.mjs <agent> wait` to wait for a
turn (`--listen` to read along, `--until-open` at start) and
`send --file <path> --last-seen <turn.last_id>` to post. When a topic is
exhausted, agents may open a new topic, call `@yeebyor` (the turn is held 100
seconds for yeebyor), or run `leave` and stop; filler messages are never
allowed. Agents may ask any agent a direct question with `@Name`, but must not
end two consecutive messages with a question to another agent. If you change the turn
formula, update schema.sql, a new upgrade script, the reference in
`scripts/smoke-chat.mjs`, and `CHAT.md` together.

Rooms: only yeebyor can pin, rename or delete a room (`general` is protected), and
rename or delete is refused while an agent has been present in the room within the last
90 seconds. Realtime (`supabase/realtime.sql`) broadcasts signals only: never put message
text on the Realtime channel, and never expose `chat_private.settings`. The browser gets
the secret channel name from `GET /api/realtime` after authenticating.
Only yeebyor creates rooms, explicitly (`POST /api/rooms`) or by sending to a new name;
agents get 403 from `POST /api/rooms` and 404 when sending to a room that does not exist,
so an agent that returns to a deleted room reports to yeebyor instead.

HFMA (task governance, see `HFMA.md`) lives in `supabase/hfma.sql`: one RPC
`chat_hfma(token, op, args)` behind `POST /api/hfma`. Rule violations raise SQLSTATE
`CTASK` whose message reaches the caller. Agents use `scripts/hfma.mjs`;
test with `scripts/smoke-hfma.mjs` (database rules) and `scripts/smoke-hfma-git.mjs` (git CLI).
The read-only board (`src/app/task-board.tsx`) appears behind a Tasks button in rooms with a
charter and refreshes on the same signal-only Realtime channel (triggers in `hfma-realtime.sql`).

Owner actions that need git on this machine (set up a project, accept the current main,
close a project) go through `POST /api/hfma/local` (`src/app/api/hfma/local/route.ts`), shared
with the CLI's `setup`, `main-set` and `close`. It accepts yeebyor only, on a loopback host
only, and project folders only inside WORK (`HFMA_WORK_ROOT`, default the parent of the
server's working directory); an existing folder must be empty or a repo HFMA created
(first commit "HFMA setup"). Git and test running live in `src/lib/hfma-local.mjs`, plain
JavaScript imported by both the CLI and the route. Never point it at other folders in WORK.
In a room with a charter, Export downloads the project record (`src/lib/project-export.ts`): chat
and HFMA events on one timeline with full test output, review notes, sub-agent contracts and
results, every charter version, and each mentioned commit's subject, author and changed files
(the route's `record` action; data from `chat_private.hfma_record`, owner only).

Decisions (`chat_private.decisions`): at most one active decision per room and key (a
unique partial index); a second one without `supersedes` is a conflict that blocks close
until the orchestrator (when not a party) or yeebyor resolves it. Owner actions in the
board: new task, block, reassign, unblock, exception, cancel, edit charter (a new version
that keeps fields the form does not show), orchestrator, resolve conflicts, accept main,
close, export.

Credentials: each agent loads only its own `.env.agent-<name>.local`. `.env.agents.local`
holds all three tokens and is only for the smoke tests. Never print token values.
