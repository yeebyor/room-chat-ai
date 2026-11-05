// Standing by for every room, with the real `chat.mjs wait --all` against a running app.
// Stop any agent standing by first: these are real rooms, so it would be woken.
// Run: node --env-file=.env.local --env-file=.env.agents.local scripts/smoke-standby.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.CHAT_BASE_URL || 'http://localhost:3000';
const script = fileURLToPath(new URL('./chat.mjs', import.meta.url));
const tokens = { GPT: process.env.CHAT_GPT_TOKEN, Claude: process.env.CHAT_CLAUDE_TOKEN, Gemini: process.env.CHAT_GEMINI_TOKEN, yeebyor: process.env.CHAT_USER_TOKEN };
assert.ok(Object.values(tokens).every(Boolean), 'Load both .env.local and .env.agents.local');
const id = randomUUID().slice(0, 8);
const roomA = `standbycheck-${id}-a`;
const roomB = `standbycheck-${id}-b`;

// A temp folder of its own, and no tool session: these waits must not share records with a real agent.
const temp = mkdtempSync(join(tmpdir(), 'standby-smoke-'));
const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
for (const name of ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'ANTIGRAVITY_CONVERSATION_ID']) delete env[name];

// Starts a wait and resolves with its exit code and parsed output when it ends.
function sleep(agent, timeout = 40) {
  const child = spawn(process.execPath, [script, agent, 'wait', '--all', '--timeout', String(timeout)], { env, windowsHide: true });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const ended = new Promise((resolve) => child.on('close', (code) => resolve({ code, result: JSON.parse(out || 'null') })));
  return { child, ended, running: () => child.exitCode === null };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(path, sender, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, base), {
    method, headers: { Authorization: `Bearer ${tokens[sender]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, data: await response.json() };
}
const owner = async (room, message) => assert.equal((await api('/api/messages', 'yeebyor', { room, message, client_id: randomUUID() })).status, 201);
const reply = async (agent, room, lastSeen) => assert.equal((await api('/api/messages', agent, { room, message: `${agent} answers.`, client_id: randomUUID(), last_seen_id: lastSeen })).status, 201);
// Long enough for a wait to have reported that it stands by; it polls every 3 seconds.
const settled = () => pause(4000);

try {
  assert.equal((await api('/api/calls', 'yeebyor')).status, 422, 'Only agents stand by');
  assert.equal((await fetch(new URL('/api/calls', base))).status, 401);

  // A call in a room the agents never heard of wakes only that agent, and names the room.
  let claude = sleep('Claude');
  let gemini = sleep('Gemini');
  await settled();
  await owner(roomA, '@Claude are you there?');
  let woke = await claude.ended;
  assert.equal(woke.code, 0);
  assert.equal(woke.result.status, 'your_turn');
  assert.equal(woke.result.room, roomA, 'The result names the room that called');
  assert.match(woke.result.messages.at(-1).message, /are you there/);
  assert.ok(gemini.running(), 'Gemini was not called, so it sleeps on');
  await reply('Claude', roomA, woke.result.turn.last_id);

  // Back to sleep: the call was answered, so nothing wakes it, and a call elsewhere still does.
  claude = sleep('Claude');
  await settled();
  assert.ok(claude.running(), 'An answered call does not wake it again');
  await owner(roomB, '@Gemini and you?');
  woke = await gemini.ended;
  assert.equal(woke.result.room, roomB);
  assert.ok(claude.running());
  await reply('Gemini', roomB, woke.result.turn.last_id);

  // A message with no @ is answered once by each agent standing by, one at a time.
  gemini = sleep('Gemini');
  await settled();
  await owner(roomA, 'Anyone?');
  const answered = [];
  for (let i = 0; i < 2; i++) {
    const first = await Promise.race([claude.ended.then((r) => ({ who: 'Claude', ...r })), gemini.ended.then((r) => ({ who: 'Gemini', ...r }))]);
    assert.equal(first.result.room, roomA);
    assert.ok(!answered.includes(first.who), 'Each answers once');
    answered.push(first.who);
    await reply(first.who, roomA, first.result.turn.last_id);
    if (first.who === 'Claude') claude = { ended: new Promise(() => {}), running: () => false };
    else gemini = { ended: new Promise(() => {}), running: () => false };
  }

  // Tagged along with an agent that is not here, the one here answers.
  claude = sleep('Claude');
  gemini = sleep('Gemini');
  await settled();
  await owner(roomB, '@GPT @Claude what do you think?');
  woke = await claude.ended;
  assert.equal(woke.result.room, roomB);
  assert.ok(gemini.running());

  // Woken and read, but not answered: the same call does not wake it again.
  claude = sleep('Claude', 6);
  woke = await claude.ended;
  assert.equal(woke.code, 2);
  assert.equal(woke.result.status, 'waiting');

  // leave ends standing by at once, for every room.
  gemini.child.kill();
  await gemini.ended.catch(() => {});
  const listening = async () => (await api(`/api/messages?room=${roomA}&limit=1`, 'yeebyor')).data.turn.listening;
  for (const agent of ['Claude', 'Gemini']) await api(`/api/messages?room=${roomA}&limit=1&presence=left`, agent);
  assert.deepEqual(await listening(), []);

  console.log(JSON.stringify({ status: 'PASS', checks: 'a call in any room wakes only that agent and names the room, an answered call does not wake again, a round with no @, an absent agent tagged along, a call read but not answered, leave' }));
} finally {
  for (const room of [roomA, roomB]) {
    for (const agent of ['Claude', 'GPT', 'Gemini']) await api(`/api/messages?room=${room}&limit=1&presence=left`, agent).catch(() => {});
    await api(`/api/rooms?room=${room}`, 'yeebyor', undefined, 'DELETE').catch(() => {});
  }
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
