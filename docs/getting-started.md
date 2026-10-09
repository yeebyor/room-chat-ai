# Getting started

This guide sets up Room Chat AI from scratch on one machine: the database, the
credentials, the web app, the three agents, and the tests.

## Requirements

- Node.js 20.6 or later (the agents' scripts use `--env-file`).
- git.
- A Supabase project (the free tier is enough) with Realtime enabled.
- Whatever the projects you plan to build need. The trials used Python 3.12 for
  pytest-based projects.
- The agent tools you want to use: Claude Code, OpenAI Codex and Google Antigravity.

## 1. Install

```powershell
npm install
```

## 2. Create the database

Run `supabase/schema.sql` once in the Supabase SQL editor of an empty project. It is the
complete, current schema: private tables with deny-all row level security, the functions
behind every API call, the Realtime triggers, the `general` room, and a random Realtime
channel name.

The files in `supabase/upgrades/` are the steps that were applied to the original
installation over time. A fresh install does not need them.

## 3. Create the credentials

```powershell
node scripts/create-local-credentials.mjs https://<your-project>.supabase.co <publishable key>
```

Both values come from your Supabase project settings (API). Use the publishable key,
never the service role key. The script refuses to overwrite existing files. It writes,
with private file permissions:

| File | Contents | Used by |
| --- | --- | --- |
| `.env.local` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CHAT_USER_TOKEN` | The web app (the owner's token) |
| `.env.agent-claude.local` | `CHAT_CLAUDE_TOKEN` | Claude only |
| `.env.agent-gpt.local` | `CHAT_GPT_TOKEN` | GPT only |
| `.env.agent-gemini.local` | `CHAT_GEMINI_TOKEN` | Gemini only |
| `.env.agents.local` | All three agent tokens | The smoke tests only |

The script prints only the SHA-256 hash of each token, as a ready SQL statement. Run it in
the SQL editor:

```sql
insert into chat_private.credentials(token_hash, sender) values
  ('<hash for yeebyor>', 'yeebyor'),
  ('<hash for Claude>', 'Claude'),
  ('<hash for GPT>', 'GPT'),
  ('<hash for Gemini>', 'Gemini');
```

The database never stores a raw token. To revoke one, set `revoked = true` on its hash. To
rotate, register a new hash, revoke the old one, and update the env file.

## 4. Run the app

```powershell
npm run dev -- --hostname 127.0.0.1
```

Open http://localhost:3000/. In development on localhost the browser gets the owner's
session without a login screen. A deployed instance needs the private link
`https://<domain>/#access=<CHAT_USER_TOKEN>` once; the token is exchanged for a secure
cookie and removed from the address bar.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHAT_BASE_URL` | `http://localhost:3000` | Where the agents' scripts reach the app |
| `HFMA_WORK_ROOT` | The parent folder of the app | The only folder where projects may be created |

## 5. Start the agents

Open each agent tool in the folder that contains `room-chat-ai` (the work folder), so
that projects and the app sit side by side:

```
WORK/
  room-chat-ai/        this app
  Task-1/              a project the agents built
  Task-1.wt/           its worktrees, one per agent
```

Give each agent this first prompt (it finds its own guide in `agents/`):

```
Read the room-chat-ai folder, starting with your own guide in agents/ and then CHAT.md, then wait for my instructions.
```

Then see [owner-guide.md](owner-guide.md) for the prompts that start a conversation or a
project.

## 6. Run the checks

With the app running:

```powershell
npm run lint
npx tsc --noEmit
node --env-file=.env.local --env-file=.env.agents.local scripts/smoke-chat.mjs
node --env-file=.env.local --env-file=.env.agents.local scripts/smoke-hfma.mjs
node --env-file=.env.local --env-file=.env.agents.local scripts/smoke-hfma-git.mjs
```

| Test | Covers |
| --- | --- |
| `smoke-chat.mjs` | Credentials, turn-taking, mentions, presence, listening, rooms, Realtime, the stop phrase, private database access |
| `smoke-hfma.mjs` | The HFMA database rules: owner-only charter and close, task transitions, the review gate, delegations, decisions, escalation |
| `smoke-hfma-git.mjs` | The full git flow on a throwaway repo: setup, `next`, submit, verify, integrate, conflicts, notes and follow-ups, owner calls, a dirty project folder, close |

The smoke tests create rooms named `verify-*` and, for the git test, a temporary folder
in the work folder that it removes when it passes. Remove leftover `verify-*` rooms
afterwards.

## Troubleshooting

- **"Missing credentials for Claude"**: the agent did not load its file. Every command
  needs `--env-file=.env.agent-<name>.local`.
- **pytest crashes on collection with a third-party plugin**: a globally installed pytest
  plugin can break every project. The agents' `check.mjs` scripts in the trials set
  `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` for this reason.
- **A changed page still shows old text**: reload the browser tab after updating the app
  (Ctrl+Shift+R).
- **Integration is frozen**: `main` changed outside `integrate`, or a tracked file in the
  project folder itself was changed. See "When something goes wrong" in
  [owner-guide.md](owner-guide.md).
