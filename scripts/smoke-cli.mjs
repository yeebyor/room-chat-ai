// The agent command line (scripts/chat.mjs) and the hand-off reminders against a fake server, so it
// needs no database. Run: node scripts/smoke-cli.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffReminder } from '../src/lib/handoff.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const room = `zz-cli-${process.pid}`;
const seenFile = join(tmpdir(), `room-chat-ai-seen-GPT-${room}.json`);
rmSync(seenFile, { force: true });

// A fake room: three messages and a turn with every field the real server sends.
const messages = [
  { id: '5', sender: 'yeebyor', message: 'first', created_at: 'x', client_id: 'c1', room },
  { id: '6', sender: 'Claude', message: 'second', created_at: 'x', client_id: 'c2', room },
  { id: '7', sender: 'yeebyor', message: '@GPT third', created_at: 'x', client_id: 'c3', room },
];
const fullTurn = {
  next: 'GPT', stopped: false, probabilities: { Claude: 0, GPT: 1, Gemini: 0 }, roll: 0.42, last_id: '7', last_sender: 'yeebyor',
  open_at: '2026-10-19T10:00:00Z', called: ['GPT'], round: [], present: ['GPT'], listening: [], gather_until: null, gather_seed: null, owner_called_until: null,
};
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ room, messages, count: messages.length, turn: fullTurn }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const home = mkdtempSync(join(tmpdir(), 'cli-home-'));
const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, CHAT_GPT_TOKEN: 'x', CHAT_BASE_URL: `http://127.0.0.1:${server.address().port}` };
for (const name of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID']) delete baseEnv[name];
const run = (args, env = baseEnv) => new Promise((resolve) => execFile('node', ['scripts/chat.mjs', 'GPT', ...args], { env, cwd: repo }, (error, stdout, stderr) => resolve({ out: stdout, err: stderr, json: () => JSON.parse(stdout) })));
const record = () => JSON.parse(readFileSync(seenFile, 'utf8'));

try {
  // The turn is printed as an agent needs it: no odds, roll or seed, and only the lists that hold something.
  const turn = (await run(['turn', room])).json();
  assert.deepEqual(Object.keys(turn).sort(), ['called', 'last_id', 'last_sender', 'listening', 'next', 'open_at', 'present']);
  assert.equal(turn.last_id, '7');

  // wait --wake (the background run of a Codex agent) must not mark messages as seen: the agent reads
  // them with its next command. A plain wait shows what is new once, then nothing.
  writeFileSync(seenFile, JSON.stringify({ session: null, seen: '5', at: Date.now() }));
  await run(['wait', room, '--timeout', '5', '--listen', '--wake', 'codex']);
  assert.equal(record().seen, '5', 'wait --wake leaves the messages unseen');
  const first = (await run(['wait', room, '--timeout', '5'])).json();
  assert.deepEqual(first.messages.map((m) => m.id), ['6', '7'], 'only what is new, not the earlier ones');
  assert.equal(first.turn.probabilities, undefined, 'the odds are not printed on a wake');
  assert.equal(record().seen, '7');
  assert.deepEqual((await run(['wait', room, '--timeout', '5'])).json().messages, [], 'the second read shows nothing new');

  // read --new is the same for an agent that wants to answer: what is new and the turn. Plain read is the whole room.
  writeFileSync(seenFile, JSON.stringify({ session: null, seen: '6', at: Date.now() }));
  const fresh = (await run(['read', room, '--new'])).json();
  assert.deepEqual(fresh.messages.map((m) => m.id), ['7']);
  assert.equal(fresh.turn.last_id, '7');
  assert.equal((await run(['read', room])).json().messages.length, 3, 'plain read prints the whole room');

  // The join record: written on the first command of a session in a room, kept by later ones, new for a new session.
  rmSync(seenFile, { force: true });
  const session1 = { ...baseEnv, CLAUDE_CODE_SESSION_ID: 'cli-session-1' };
  await run(['turn', room], session1);
  let r = record();
  assert.equal(r.session, 'cli-session-1');
  assert.equal(r.tool, 'claude');
  assert.equal(r.seen, null, 'joining does not pretend any message was seen');
  const joinedAt = r.joined.at;
  await run(['wait', room, '--timeout', '5'], session1);
  r = record();
  assert.equal(r.seen, '7');
  assert.equal(r.joined.at, joinedAt, 'later commands keep the original join');
  assert.equal(r.tool, 'claude');
  await run(['turn', room], { ...baseEnv, CLAUDE_CODE_SESSION_ID: 'cli-session-2' });
  r = record();
  assert.equal(r.session, 'cli-session-2');
  assert.equal(r.seen, null);
  assert.ok(r.joined.at >= joinedAt);
} finally {
  rmSync(seenFile, { force: true });
  server.close();
}

// The call each hand-off command reminds an agent to make.
const base = { me: 'Gemini', room: 'p', task: 225, orchestrator: 'Claude' };
const submit = handoffReminder('submit', base);
assert.match(submit, /call one other agent in the room with @Name to review it/);
assert.match(submit, /chat\.mjs Gemini read p --new/);
assert.match(submit, /chat\.mjs Gemini wait p --listen --timeout 14400 in the background/);
assert.doesNotMatch(submit, /--wake codex/);
assert.match(handoffReminder('approve', { ...base, me: 'GPT', team: 'Gemini' }), /call @Gemini in the room: say it is approved and ask them to run integrate.*--wake codex/);
assert.match(handoffReminder('reject', { ...base, team: 'Claude' }), /call @Claude in the room: say it was rejected/);
assert.match(handoffReminder('integrate', base), /call the orchestrator, @Claude, so the next task can start/);
const ready = [{ id: 8, title: 'Step 2', team: 'GPT' }];
assert.match(handoffReminder('integrate', { ...base, me: 'Claude', ready }), /you are the orchestrator.*call the agent whose task is now ready: @GPT \(task #8, Step 2\)/);
assert.match(handoffReminder('integrate', { ...base, me: 'Claude', ready: [{ id: 8, title: 't', team: 'Claude' }] }), /Your own task #8 is ready too: claim it now instead of sleeping/);
assert.match(handoffReminder('integrate', { ...base, me: 'Claude', ready: [] }), /every task is done, call @yeebyor to assess/);
for (const kind of ['submit', 'approve', 'reject', 'integrate']) assert.ok(!handoffReminder(kind, { ...base, team: 'Claude' }).includes(String.fromCharCode(0x2014)), 'no em dash');

console.log(JSON.stringify({ status: 'PASS', checks: 'compact turn, wait --wake leaves messages unseen, delta reads, read --new, join record per session, hand-off reminders' }));
