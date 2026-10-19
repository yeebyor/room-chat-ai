// Token usage reader (src/lib/usage.mjs) on synthetic session logs; needs no server or database.
// Run: node scripts/smoke-usage.mjs
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionOf, sessionUsage, usageSince } from '../src/lib/usage.mjs';

const home = mkdtempSync(join(tmpdir(), 'usage-smoke-'));
const figures = (u) => ({ input: u.input, cached: u.cached, output: u.output });

// Claude Code: a message can span several lines with the same id; the last line has the final
// counts. A half-written last line is ignored until it is finished; a replaced log starts over.
const claudeDir = join(home, '.claude', 'projects', 'p');
mkdirSync(claudeDir, { recursive: true });
const claudeLog = join(claudeDir, 'claude-session-1.jsonl');
const claudeLine = (id, input, create, cached, output) => JSON.stringify({ message: { id, usage: { input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: cached, output_tokens: output } } }) + '\n';
writeFileSync(claudeLog, claudeLine('m1', 10, 5, 100, 1) + claudeLine('m1', 10, 5, 100, 40) + claudeLine('m2', 3, 0, 200, 7));
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', home)), { input: 18, cached: 300, output: 47 }, 'same id counted once, last line wins');
appendFileSync(claudeLog, claudeLine('m3', 1, 1, 1, 1).slice(0, 20));
assert.equal(sessionUsage('claude', 'claude-session-1', home).output, 47, 'a half-written line is ignored');
appendFileSync(claudeLog, claudeLine('m3', 1, 1, 1, 1).slice(20));
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', home)), { input: 20, cached: 301, output: 48 }, 'the finished line is counted once');
writeFileSync(claudeLog, claudeLine('z', 1, 0, 2, 3));
assert.deepEqual(figures(sessionUsage('claude', 'claude-session-1', home)), { input: 1, cached: 2, output: 3 }, 'a replaced log starts over');

// Codex: the last cumulative total_token_usage counts, and its input includes the cached part.
const codexDir = join(home, '.codex', 'sessions', '2026', '10', '19');
mkdirSync(codexDir, { recursive: true });
const tokenCount = (input, cached, output) => JSON.stringify({ payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } }) + '\n';
writeFileSync(join(codexDir, 'rollout-2026-10-19T10-00-00-codex-thread-1.jsonl'), tokenCount(1000, 900, 10) + JSON.stringify({ payload: { type: 'message' } }) + '\n' + tokenCount(5000, 4000, 60));
assert.deepEqual(figures(sessionUsage('codex', 'codex-thread-1', home)), { input: 1000, cached: 4000, output: 60 });

// Antigravity: every model step adds its own counts.
const agyDir = join(home, '.gemini', 'antigravity-cli', 'brain', 'agy-conversation-1', '.system_generated', 'logs');
mkdirSync(agyDir, { recursive: true });
writeFileSync(join(agyDir, 'transcript_full.jsonl'),
  JSON.stringify({ step_index: 1, input_tokens: 100, cache_read_tokens: 0, output_tokens: 5 }) + '\n'
  + JSON.stringify({ step_index: 2, type: 'tool' }) + '\n'
  + JSON.stringify({ step_index: 3, input_tokens: 20, cache_read_tokens: 100, output_tokens: 7 }) + '\n');
assert.deepEqual(figures(sessionUsage('antigravity', 'agy-conversation-1', home)), { input: 120, cached: 100, output: 12 });

// Unknown or unsafe sessions read nothing.
assert.equal(sessionUsage('claude', 'no-such-session', home), null);
assert.equal(sessionUsage('claude', '../../etc/passwd', home), null);
assert.equal(sessionUsage('bogus', 'abcdef-123456', home), null);

// Since a snapshot, never below zero; which tool a process runs in.
assert.deepEqual(usageSince({ input: 50, cached: 10, output: 9 }, { input: 20, cached: 10, output: 4 }), { input: 30, cached: 0, output: 5 });
assert.deepEqual(usageSince({ input: 1, cached: 0, output: 0 }, { input: 5, cached: 0, output: 0 }), { input: 0, cached: 0, output: 0 });
assert.deepEqual(sessionOf({ CODEX_THREAD_ID: 'a' }), { tool: 'codex', session: 'a' });
assert.deepEqual(sessionOf({ CLAUDE_CODE_SESSION_ID: 'b' }), { tool: 'claude', session: 'b' });
assert.deepEqual(sessionOf({ ANTIGRAVITY_CONVERSATION_ID: 'c' }), { tool: 'antigravity', session: 'c' });
assert.equal(sessionOf({}), null);

console.log(JSON.stringify({ status: 'PASS', checks: 'Claude Code (dedupe by message, partial line, replaced log), Codex (cumulative, cached part), Antigravity (per step), unsafe sessions, usage since a snapshot, tool detection' }));
