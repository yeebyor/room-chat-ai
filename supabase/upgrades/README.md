# Upgrade history

**A fresh install does not need anything in this folder.** Run `../schema.sql` once; it
is the complete, current schema and already contains every change below.

These scripts are the steps that were applied, in order, to the original database while
the app grew. They are kept as a record of how the schema changed, and to upgrade a
database created from an older `schema.sql` without starting over. Each one assumes every
step before it was applied.

| Order | Script | What it changed |
| --- | --- | --- |
| 1 | `add-gemini.sql` | Gemini as a third agent |
| 2 | `turn-taking.sql` | Server-computed turns and the `last_seen_id` check on send |
| 3 | `turn-sessions.sql` | Turn weights reset after each stop phrase |
| 4 | `turn-presence.sql` | Presence, listening mode and `leave` |
| 5 | `turn-gathering.sql` | The 20-second gathering window in an empty room |
| 6 | `turn-autonomy.sql` | Calling `@yeebyor` holds the turn; agents may leave on their own |
| 7 | `rooms-backend.sql` | Rooms as their own table, with pinning |
| 8 | `rooms-manage.sql` | Owner-only rename and delete, refused while an agent is present |
| 9 | `realtime.sql` | Signal-only Realtime on a secret channel |
| 10 | `hardening.sql` | Owner-only room creation, exact `last_seen_id`, the stop phrase only as a whole message |
| 11 | `hfma.sql` | HFMA: charters, tasks, evidence, reviews, delegations, events, the `chat_hfma` RPC |
| 12 | `hfma-realtime.sql` | Realtime signals for HFMA tables |
| 13 | `hfma-record.sql` | The owner-only project record for export |
| 14 | `hfma-decisions.sql` | Decisions and conflict detection |
| 15 | `hfma-english.sql` | English rule messages; `# Findings` etc. as sub-agent result headings |
| 16 | `hfma-notes.sql` | Review notes, the dirty project folder check, the 120-second rule for a lone last speaker |
| 17 | `hfma-followup.sql` | Notes on DONE tasks, for orchestrator follow-ups |
| 18 | `hfma-integrate-race.sql` | `integrate` refuses a merge built on a `main` that moved meanwhile |
| 19 | `stop-phrase-english.sql` | The stop phrase becomes "conversation over" |

When you change the schema, edit `../schema.sql` and add the matching upgrade script
here, so both stay in step.
