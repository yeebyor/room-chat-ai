// The agent command line (scripts/chat.mjs) and the hand-off reminders against a fake server, so it
// needs no database. Run: node scripts/smoke-cli.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffReminder } from '../src/lib/handoff.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
// A temp folder of its own, so the test never touches the records of an agent standing by.
const temp = mkdtempSync(join(tmpdir(), 'cli-temp-'));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
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
// Sends: the first `failPosts` answer 503 (Supabase cannot be reached), `rejectPosts` answers 409.
const posts = [];
let lastPresence = null;
let lastBefore = null;
let crowded = false;
const afters = [];
let standbyCalls = [];
let failPosts = 0;
let rejectPosts = false;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body);
      posts.push(data);
      if (failPosts > 0) { failPosts--; res.statusCode = 503; res.end(JSON.stringify({ error: 'Supabase cannot be reached right now. Try again.' })); }
      else if (rejectPosts) { res.statusCode = 409; res.end(JSON.stringify({ error: 'It is not your turn.' })); }
      else res.end(JSON.stringify({ message: { id: '8', room, sender: 'GPT', message: data.message, client_id: data.client_id, created_at: 'x' } }));
    });
    return;
  }
  const query = new URL(req.url, 'http://localhost').searchParams;
  if (req.url.startsWith('/api/calls')) {
    afters.push(query.get('after'));
    res.end(JSON.stringify({ after: '4', calls: standbyCalls }));
    return;
  }
  lastPresence = query.get('presence');
  lastBefore = query.get('before_id');
  const list = crowded ? Array.from({ length: 100 }, (_, i) => ({ ...messages[0], id: String(i + 1) })) : messages;
  res.end(JSON.stringify({ room, messages: list, count: list.length, turn: fullTurn }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const home = mkdtempSync(join(tmpdir(), 'cli-home-'));
const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, CHAT_GPT_TOKEN: 'x', CHAT_BASE_URL: `http://127.0.0.1:${server.address().port}` };
for (const name of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID']) delete baseEnv[name];
const run = (args, env = baseEnv) => new Promise((resolve) => execFile('node', ['scripts/chat.mjs', 'GPT', ...args], { env, cwd: repo }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout, err: stderr, json: () => JSON.parse(stdout) })));
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

  // read --new is the same for an agent that wants to answer: what is new and the turn. Plain read is the latest 100.
  writeFileSync(seenFile, JSON.stringify({ session: null, seen: '6', at: Date.now() }));
  const fresh = (await run(['read', room, '--new'])).json();
  assert.deepEqual(fresh.messages.map((m) => m.id), ['7']);
  assert.equal(fresh.turn.last_id, '7');
  const small = (await run(['read', room])).json();
  assert.equal(small.messages.length, 3, 'plain read prints a small room whole');
  assert.equal(small.older_not_shown, undefined);
  // A room with more than a page says so and pages back, without moving what the agent has seen.
  crowded = true;
  assert.match((await run(['read', room])).json().older_not_shown, /read .* --before 1/);
  writeFileSync(seenFile, JSON.stringify({ session: null, seen: '3', at: Date.now() }));
  await run(['read', room, '--before', '1']);
  assert.equal(lastBefore, '1');
  assert.equal(record().seen, '3', 'paging back does not mark the room as seen');
  crowded = false;

  // wait --all names no room, wakes with the room that called, and keeps where it started.
  rmSync(seenFile, { force: true });
  standbyCalls = [];
  const nobody = await run(['wait', '--all', '--timeout', '1']);
  assert.equal(nobody.code, 2, 'nobody called: keep waiting');
  assert.equal(nobody.json().status, 'waiting');
  assert.equal(afters[0], null, 'the server picks the start on the first call');
  standbyCalls = [{ room, last_id: '7' }];
  const woken = (await run(['wait', '--all', '--timeout', '5'])).json();
  assert.equal(woken.status, 'your_turn');
  assert.equal(woken.room, room, 'the result says which room called');
  assert.equal(afters.at(-1), '4', 'later waits keep the start');
  assert.equal(lastPresence, 'listening');
  assert.equal(record().seen, '7');
  assert.equal((await run(['wait', '--all', '--timeout', '1'])).json().status, 'waiting', 'a room already read does not wake it twice');
  standbyCalls = [];
  assert.match((await run(['read', room, '--all'])).err, /--all works with wait only/);

  // A long wait (ten minutes or more) always listens, even without --listen; a short one stays active.
  await run(['wait', room, '--timeout', '600']);
  assert.equal(lastPresence, 'listening', 'a long wait is a sleep and listens');
  await run(['wait', room, '--timeout', '30']);
  assert.equal(lastPresence, 'active', 'a short wait stays active');

  // send: a passing server error is sent again by the script with the same client_id (so it can never
  // post twice); a refusal (4xx) is not sent again.
  const reply = join(home, 'reply.txt');
  writeFileSync(reply, 'Kabar baik.');
  failPosts = 1;
  const retried = await run(['send', room, '--file', reply, '--last-seen', '7']);
  assert.equal(retried.code, 0, retried.err);
  assert.equal(retried.json().message.id, '8');
  assert.equal(posts.length, 2, 'one try failed, the second got through');
  assert.equal(posts[0].client_id, posts[1].client_id, 'the same client_id, so the server never stores it twice');
  assert.match(retried.err, /try 1 of 3/);
  posts.length = 0;
  failPosts = 5;
  const gaveUp = await run(['send', room, '--file', reply, '--last-seen', '7']);
  assert.notEqual(gaveUp.code, 0, 'gives up after three tries');
  assert.equal(posts.length, 3);
  posts.length = 0;
  failPosts = 0;
  rejectPosts = true;
  const refused = await run(['send', room, '--file', reply, '--last-seen', '7']);
  assert.notEqual(refused.code, 0);
  assert.equal(posts.length, 1, 'a refusal is not sent again');
  rejectPosts = false;

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

  // The record of resting, for the sidebar: leave and a sleeping wait write it, waking clears it.
  const restFile = join(tmpdir(), 'room-chat-ai-resting-GPT.json');
  await run(['leave', room], session1);
  assert.equal(lastPresence, 'left');
  assert.equal(JSON.parse(readFileSync(restFile, 'utf8')).session, 'cli-session-1');
  await run(['wait', room, '--timeout', '5'], session1);
  assert.ok(!existsSync(restFile), 'a wait that is not a sleep means it came back');
  standbyCalls = [];
  const sleeping = run(['wait', '--all', '--timeout', '4'], session1);
  for (let i = 0; i < 100 && !existsSync(restFile); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const restedAt = JSON.parse(readFileSync(restFile, 'utf8')).at;
  assert.equal((await run(['wait', '--all', '--timeout', '4'], session1)).json().status, 'already_waiting');
  assert.equal(JSON.parse(readFileSync(restFile, 'utf8')).at, restedAt, 'a second wait changes nothing');
  await sleeping;
  assert.ok(!existsSync(restFile), 'a wait that ends is a wake');
} finally {
  rmSync(temp, { recursive: true, force: true });
  server.close();
}

// The call each hand-off command reminds an agent to make.
const base = { me: 'Gemini', room: 'p', task: 225, orchestrator: 'Claude' };
const submit = handoffReminder('submit', base);
assert.match(submit, /call one other agent in the room with @Name to review it/);
assert.match(submit, /chat\.mjs Gemini read p --new/);
assert.match(submit, /chat\.mjs Gemini wait --all --timeout 14400 in the background/);
assert.doesNotMatch(submit, /--wake codex/);
assert.match(handoffReminder('approve', { ...base, me: 'GPT', team: 'Gemini' }), /call @Gemini in the room: say it is approved and ask them to run integrate.*--wake codex/);
assert.match(handoffReminder('reject', { ...base, team: 'Claude' }), /call @Claude in the room: say it was rejected/);
assert.match(handoffReminder('integrate', base), /call the orchestrator, @Claude, so the next task can start/);
const ready = [{ id: 8, title: 'Step 2', team: 'GPT' }];
assert.match(handoffReminder('integrate', { ...base, me: 'Claude', ready }), /you are the orchestrator.*call the agent whose task is now ready: @GPT \(task #8, Step 2\)/);
assert.match(handoffReminder('integrate', { ...base, me: 'Claude', ready: [{ id: 8, title: 't', team: 'Claude' }] }), /Your own task #8 is ready too: claim it now instead of sleeping/);
assert.match(handoffReminder('integrate', { ...base, me: 'Claude', ready: [] }), /every task is done, call @yeebyor to assess/);
for (const kind of ['submit', 'approve', 'reject', 'integrate']) assert.ok(!handoffReminder(kind, { ...base, team: 'Claude' }).includes(String.fromCharCode(0x2014)), 'no em dash');

console.log(JSON.stringify({ status: 'PASS', checks: 'compact turn, wait --wake leaves messages unseen, delta reads, read --new, read says when older messages exist and pages back, wait --all, a long wait always listens, send retries a passing server error with the same client_id, join record per session, the record of resting, hand-off reminders' }));
