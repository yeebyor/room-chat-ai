// Token usage reader (src/lib/usage.mjs) on synthetic session logs; needs no server or database.
// Run: node scripts/smoke-usage.mjs
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionOf, sessionUsage } from '../src/lib/usage.mjs';

const home = mkdtempSync(join(tmpdir(), 'usage-smoke-'));
const figures = (u) => ({ input: u.input, cached: u.cached, output: u.output });
const iso = (minute) => `2026-10-19T10:${String(minute).padStart(2, '0')}:00.000Z`;
const at = (minute) => Date.parse(iso(minute));

// Claude Code: a message can span several lines with the same id; the last line has the final
// counts. A half-written last line is ignored until it is finished; a replaced log starts over.
const claudeDir = join(home, '.claude', 'projects', 'p');
mkdirSync(claudeDir, { recursive: true });
const claudeLog = join(claudeDir, 'claude-session-1.jsonl');
const claudeLine = (id, minute, input, create, cached, output) => JSON.stringify({ timestamp: iso(minute), message: { id, usage: { input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: cached, output_tokens: output } } }) + '\n';
writeFileSync(claudeLog, claudeLine('m1', 1, 10, 5, 100, 1) + claudeLine('m1', 1, 10, 5, 100, 40) + claudeLine('m2', 5, 3, 0, 200, 7));
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', 0, home)), { input: 18, cached: 300, output: 47 }, 'same id counted once, last line wins; cache writes count as input');
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', at(3), home)), { input: 3, cached: 200, output: 7 }, 'only the requests from the join on');
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', at(9), home)), { input: 0, cached: 0, output: 0 }, 'nothing since a later time');
appendFileSync(claudeLog, claudeLine('m3', 6, 1, 1, 1, 1).slice(0, 20));
assert.equal(sessionUsage('claude', 'claude-session-1', 0, home).output, 47, 'a half-written line is ignored');
appendFileSync(claudeLog, claudeLine('m3', 6, 1, 1, 1, 1).slice(20));
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', 0, home)), { input: 20, cached: 301, output: 48 }, 'the finished line is counted once');
writeFileSync(claudeLog, claudeLine('z', 2, 1, 0, 2, 3));
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', 0, home)), { input: 1, cached: 2, output: 3 }, 'a replaced log starts over');

// Codex: total_token_usage is cumulative and its input includes the cached part, so a request is
// the difference from the total before it. A cold request (nothing cached) counts as input.
const codexDir = join(home, '.codex', 'sessions', '2026', '10', '19');
mkdirSync(codexDir, { recursive: true });
const tokenCount = (minute, input, cached, output) => JSON.stringify({ timestamp: iso(minute), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } }) + '\n';
writeFileSync(join(codexDir, 'rollout-2026-10-19T10-00-00-codex-thread-1.jsonl'),
  tokenCount(1, 1000, 900, 10) + JSON.stringify({ timestamp: iso(2), payload: { type: 'message' } }) + '\n'
  + tokenCount(1, 1000, 900, 10)               // the same total again adds nothing
  + tokenCount(5, 96000, 12900, 40)            // after a long idle: 95000 read, 12000 of it from cache
  + tokenCount(6, 197000, 110000, 100));
assert.deepEqual(figures(sessionUsage('codex', 'codex-thread-1', 0, home)), { input: 87000, cached: 110000, output: 100 });
assert.deepEqual(figures(sessionUsage('codex', 'codex-thread-1', at(5), home)), { input: 86900, cached: 109100, output: 90 }, 'only the requests from the join on');

// Antigravity: every model step adds its own counts, with its own time.
const agyDir = join(home, '.gemini', 'antigravity-cli', 'brain', 'agy-conversation-1', '.system_generated', 'logs');
mkdirSync(agyDir, { recursive: true });
writeFileSync(join(agyDir, 'transcript_full.jsonl'),
  JSON.stringify({ step_index: 1, created_at: iso(1), input_tokens: 100, cache_read_tokens: 0, output_tokens: 5 }) + '\n'
  + JSON.stringify({ step_index: 2, created_at: iso(2), type: 'tool' }) + '\n'
  + JSON.stringify({ step_index: 3, created_at: iso(4), input_tokens: 20, cache_read_tokens: 100, output_tokens: 7 }) + '\n');
assert.deepEqual(figures(sessionUsage('antigravity', 'agy-conversation-1', 0, home)), { input: 120, cached: 100, output: 12 });
assert.deepEqual(figures(sessionUsage('antigravity', 'agy-conversation-1', at(3), home)), { input: 20, cached: 100, output: 7 });

// Unknown or unsafe sessions read nothing.
assert.equal(sessionUsage('claude', 'no-such-session', 0, home), null);
assert.equal(sessionUsage('claude', '../../etc/passwd', 0, home), null);
assert.equal(sessionUsage('bogus', 'abcdef-123456', 0, home), null);

// Which tool a process runs in.
assert.deepEqual(sessionOf({ CODEX_THREAD_ID: 'a' }), { tool: 'codex', session: 'a' });
assert.deepEqual(sessionOf({ CLAUDE_CODE_SESSION_ID: 'b' }), { tool: 'claude', session: 'b' });
assert.deepEqual(sessionOf({ ANTIGRAVITY_CONVERSATION_ID: 'c' }), { tool: 'antigravity', session: 'c' });
assert.equal(sessionOf({}), null);

console.log(JSON.stringify({ status: 'PASS', checks: 'Claude Code (dedupe by message, cache writes as input, since a time, partial line, replaced log), Codex (cumulative totals, cold request, repeated total), Antigravity (per step, since a time), unsafe sessions, tool detection' }));
