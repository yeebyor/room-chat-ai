import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { RealtimeClient } from '@supabase/realtime-js';

const base = process.env.CHAT_BASE_URL || 'http://localhost:3000';
const room = `verify-${randomUUID().slice(0, 8)}`;
const tokens = { GPT: process.env.CHAT_GPT_TOKEN, Claude: process.env.CHAT_CLAUDE_TOKEN, Gemini: process.env.CHAT_GEMINI_TOKEN, yeebyor: process.env.CHAT_USER_TOKEN };
assert.ok(Object.values(tokens).every(Boolean), 'Load both .env.local and .env.agents.local');

async function request(path, sender, body, extraHeaders = {}, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(sender ? { Authorization: `Bearer ${tokens[sender]}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, data: await response.json() };
}

assert.equal((await request('/api/messages')).status, 401);
assert.equal((await request('/api/messages', null, undefined, { Authorization: `Bearer ${'0'.repeat(64)}` })).status, 401);
assert.equal((await request('/api/health', 'GPT')).data.database, 'connected');
assert.equal((await request('/api/messages?room=bad%20room', 'GPT')).status, 422);
assert.equal((await request('/api/messages?limit=201', 'GPT')).status, 422);
assert.equal((await request('/api/messages?after_id=9223372036854775808', 'GPT')).status, 422);
assert.equal((await request('/api/messages?after_id=1&before_id=2', 'GPT')).status, 422);
assert.equal((await request('/api/messages', 'GPT', { sender: 'Claude', message: 'spoof', client_id: randomUUID() })).status, 422);
assert.equal((await request('/api/messages', 'GPT', { message: ' ', client_id: randomUUID() })).status, 422);
assert.equal((await request('/api/messages', 'GPT', { message: 'a'.repeat(4001), client_id: randomUUID() })).status, 422);
assert.equal((await request('/api/messages', 'GPT', { message: 'valid', client_id: 'invalid' })).status, 422);
assert.equal((await request('/api/messages', 'GPT', { message: 'csrf', client_id: randomUUID() }, { Origin: 'https://other.example' })).status, 403);

// Reference implementation of chat_private.compute_turn, to check the server's math.
// The test reports presence through the API and mirrors it here.
const AGENTS = ['Claude', 'GPT', 'Gemini'];
const STOP = /^\s*conversation\s+over\s*[.!]*\s*$/i;
const presence = {};
function expectedTurn(messages) {
  const last = messages.at(-1);
  if (last?.sender === 'yeebyor' && STOP.test(last.message)) return { next: null, stopped: true };
  // An agent calling @yeebyor holds the turn; checks run well inside the 100 seconds.
  if (last && last.sender !== 'yeebyor' && /@yeebyor\b/i.test(last.message)) return { next: null, stopped: false };
  // Balance only counts the current discussion, i.e. after the last stop phrase.
  const session = messages.slice(messages.findLastIndex((m) => m.sender === 'yeebyor' && STOP.test(m.message)) + 1);
  const recent = session.slice(-6);
  const others = AGENTS.filter((agent) => agent !== last?.sender);
  const called = others.filter((agent) => last && new RegExp(`@${agent}\\b`, 'i').test(last.message));
  const present = others.filter((agent) => presence[agent] === 'active');
  const anyPresence = Object.keys(presence).length > 0;
  const lone = AGENTS.includes(last?.sender) && presence[last.sender] === 'active' ? [last.sender] : [];
  const pool = called.length ? called : present.length ? present : anyPresence ? lone : others;
  const weights = AGENTS.map((agent) => {
    if (!pool.includes(agent)) return 0;
    if (called.length === 1) return 1;
    return 1 / (1 + recent.filter((message) => message.sender === agent).length);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!total) return { next: null, stopped: false };
  const roll = parseInt(createHash('sha256').update(`${room}:${last?.id ?? 0}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
  let cumulative = 0;
  let next = null;
  weights.forEach((weight, i) => {
    if (!weight) return;
    cumulative += weight / total;
    if (!next && (roll < cumulative || weights.slice(i + 1).every((later) => !later))) next = AGENTS[i];
  });
  return { next, stopped: false, probabilities: Object.fromEntries(AGENTS.map((agent, i) => [agent, weights[i] / total])) };
}
async function checkedTurn() {
  const { messages, turn } = (await request(`/api/messages?room=${room}&limit=200`, 'Claude')).data;
  const expected = expectedTurn(messages);
  assert.equal(turn.next, expected.next);
  assert.equal(turn.stopped, expected.stopped);
  if (expected.probabilities) AGENTS.forEach((agent) => assert.ok(Math.abs(turn.probabilities[agent] - expected.probabilities[agent]) < 0.0001));
  return turn;
}
async function report(agent, mode) {
  assert.equal((await request(`/api/messages?room=${room}&limit=1&presence=${mode}`, agent)).status, 200);
  if (mode === 'left') delete presence[agent];
  else presence[agent] = mode;
}
const seen = (turn) => turn.last_id ?? '0';
const say = (sender, message, extra = {}) => request('/api/messages', sender, { room, message, client_id: randomUUID(), ...extra });
const equalOdds = (turn) => AGENTS.forEach((agent) => assert.ok(Math.abs(turn.probabilities[agent] - 1 / 3) < 0.0001));

assert.equal((await request(`/api/messages?room=${room}&presence=bogus`, 'GPT')).status, 422);
assert.equal((await checkedTurn()).stopped, false, 'Empty room is open to the drawn agent');
// Plain names are ordinary text; only @mentions route the turn.
const opening = await say('yeebyor', 'Topik tes untuk Claude dan GPT: <script>literal text</script>');
assert.equal(opening.status, 201);
assert.equal(opening.data.message.sender, 'yeebyor');
let turn = await checkedTurn();
equalOdds(turn);

assert.equal((await say(turn.next, 'Tanpa cursor')).status, 422, 'Agents must send last_seen_id');
assert.equal((await say(turn.next, 'Cursor terlalu maju', { last_seen_id: String(BigInt(seen(turn)) + 1000n) })).status, 422,
  'last_seen_id above the latest message is not a message the agent read');
const payload = { room, message: 'Hai, tes "kutip" dan ✅', client_id: randomUUID(), last_seen_id: seen(turn) };
const first = await request('/api/messages', turn.next, payload);
assert.equal(first.status, 201);
assert.equal(first.data.message.sender, turn.next);
// A retry must return the stored message even though the turn has moved on.
assert.equal((await request('/api/messages', turn.next, payload)).data.message.id, first.data.message.id);
assert.equal((await request('/api/messages', turn.next, { ...payload, message: 'changed' })).status, 409);
assert.equal((await request('/api/messages', turn.next, { ...payload, sender: 'GPT' })).status, 422);

turn = await checkedTurn();
assert.notEqual(turn.next, first.data.message.sender, 'Nobody speaks twice in a row');
for (const agent of AGENTS.filter((name) => name !== turn.next)) {
  const rejected = await say(agent, 'Bukan giliran', { last_seen_id: seen(turn) });
  assert.equal(rejected.status, 409, `${agent} must wait for ${turn.next}`);
  assert.match(rejected.data.error, /not your turn/);
}
const spoken = [first.data.message.sender];
for (let i = 0; i < 5; i++) {
  turn = await checkedTurn();
  assert.equal((await say(turn.next, `Giliran ${i}`, { last_seen_id: seen(turn) })).status, 201);
  assert.notEqual(turn.next, spoken.at(-1));
  spoken.push(turn.next);
}

// One @mention hands that agent the turn without a draw.
assert.equal((await say('yeebyor', '@Gemini tolong jawab.')).status, 201);
const calledTurn = await checkedTurn();
assert.equal(calledTurn.next, 'Gemini');
assert.equal(calledTurn.probabilities.Gemini, 1);
// A reply written before a newer message is rejected as stale.
assert.equal((await say('yeebyor', 'Satu tambahan.')).status, 201);
const stale = await say('Gemini', 'Jawaban lama', { last_seen_id: seen(calledTurn) });
assert.equal(stale.status, 409);
assert.match(stale.data.error, /new messages/);
turn = await checkedTurn();
assert.equal((await say(turn.next, 'Jawaban', { last_seen_id: seen(turn) })).status, 201);

// Several @mentions restrict the draw to them.
assert.equal((await say('yeebyor', '@Claude @GPT lanjut berdua.')).status, 201);
turn = await checkedTurn();
assert.equal(turn.probabilities.Gemini, 0);
assert.equal((await say(turn.next, 'Berdua', { last_seen_id: seen(turn) })).status, 201);

// Presence: a listening agent is skipped until it is @mentioned.
await report('Claude', 'active');
await report('GPT', 'active');
await report('Gemini', 'listening');
assert.equal((await say('yeebyor', 'Lanjut tanpa panggilan.')).status, 201);
turn = await checkedTurn();
assert.equal(turn.probabilities.Gemini, 0);
assert.deepEqual([...turn.listening], ['Gemini']);
const firstSpeaker = turn.next;
assert.equal((await say(firstSpeaker, 'Satu', { last_seen_id: seen(turn) })).status, 201);
turn = await checkedTurn();
assert.equal(turn.next, firstSpeaker === 'Claude' ? 'GPT' : 'Claude', 'Only present agents are drawn');
assert.equal((await say(turn.next, 'Dua', { last_seen_id: seen(turn) })).status, 201);
assert.equal((await say('yeebyor', '@Gemini giliranmu.')).status, 201);
turn = await checkedTurn();
assert.equal(turn.next, 'Gemini');
assert.equal((await say('Gemini', 'Hadir', { last_seen_id: seen(turn) })).status, 201);
// Everyone listening: nobody may speak until someone is @mentioned.
await report('Claude', 'listening');
await report('GPT', 'listening');
assert.equal((await say('yeebyor', 'Tidak ada yang dipanggil.')).status, 201);
turn = await checkedTurn();
assert.equal(turn.next, null);
const idle = await say('Claude', 'Menyela', { last_seen_id: seen(turn) });
assert.equal(idle.status, 409);
assert.match(idle.data.error, /No agent has the turn/);
for (const agent of AGENTS) await report(agent, 'active');

// An agent calling @yeebyor holds the turn until yeebyor answers (or 100 seconds pass).
turn = await checkedTurn();
const caller = turn.next;
assert.equal((await say(caller, 'Topik ini sudah habis. @yeebyor ada kasus nyata?', { last_seen_id: seen(turn) })).status, 201);
turn = await checkedTurn();
assert.equal(turn.next, null);
assert.ok(turn.owner_called_until);
const interrupt = await say(AGENTS.find((agent) => agent !== caller), 'Menyela', { last_seen_id: seen(turn) });
assert.equal(interrupt.status, 409);
assert.match(interrupt.data.error, /Waiting for yeebyor/);
assert.equal((await say('yeebyor', 'Belum ada kasus, lanjutkan saja.')).status, 201);
assert.ok((await checkedTurn()).next, 'yeebyor answering resumes the draw at once');
// Leaving takes an agent out of the draw at once; the only agent left may speak again.
await report('Claude', 'left');
await report('GPT', 'left');
assert.equal((await say('yeebyor', 'Siapa yang masih di sini?')).status, 201);
turn = await checkedTurn();
assert.equal(turn.next, 'Gemini');
assert.deepEqual([...turn.present], ['Gemini']);
assert.equal((await say('Gemini', 'Tinggal saya sendiri.', { last_seen_id: seen(turn) })).status, 201);
turn = await checkedTurn();
assert.equal(turn.next, 'Gemini', 'The only agent present may speak again');
assert.equal((await say('Gemini', '@yeebyor saya keluar jika tidak ada arahan.', { last_seen_id: seen(turn) })).status, 201);
assert.equal((await checkedTurn()).next, null);
for (const agent of AGENTS) await report(agent, 'active');

const concurrent = await Promise.all(Array.from({ length: 4 }, (_, i) => say('yeebyor', `Concurrent ${i}`)));
assert.ok(concurrent.every((result) => result.status === 201));
// The stop phrase counts only as the whole message, not quoted or negated in a sentence.
assert.equal((await say('yeebyor', 'Do not call it conversation over yet.')).status, 201);
assert.equal((await checkedTurn()).stopped, false, 'A sentence containing the stop phrase does not stop');
assert.equal((await say('yeebyor', 'Conversation over.')).status, 201);
turn = await checkedTurn();
assert.equal(turn.stopped, true);
for (const agent of AGENTS) {
  const late = await say(agent, 'Terlambat', { last_seen_id: seen(turn) });
  assert.equal(late.status, 409, 'No agent may speak after conversation over');
  assert.match(late.data.error, /stopped by yeebyor/);
}
// A new discussion after the stop phrase starts with equal odds.
assert.equal((await say('yeebyor', 'Topik baru, siapa saja boleh mulai.')).status, 201);
equalOdds(await checkedTurn());

const all = (await request(`/api/messages?room=${room}`, 'Claude')).data.messages;
assert.equal(all.length, 30);
assert.equal(new Set(all.map((message) => message.id)).size, 30);
assert.equal((await request(`/api/messages?room=${room}`, 'Gemini')).data.count, 30);
assert.ok(all.every((message, i) => i === 0 || BigInt(message.id) > BigInt(all[i - 1].id)));
assert.equal(all[1].message, payload.message);
const after = (await request(`/api/messages?room=${room}&after_id=${first.data.message.id}`, 'GPT')).data.messages;
assert.equal(after.length, 28);
const before = (await request(`/api/messages?room=${room}&before_id=${first.data.message.id}`, 'GPT')).data.messages;
assert.equal(before.length, 1);
// Empty room: the opener is drawn 20 seconds after the first agent joins, among
// the agents that joined in that window, seeded by the join time.
const gatherRoom = `${room}-g`;
assert.equal((await request('/api/rooms', 'yeebyor', { room: gatherRoom })).status, 201);
const gatherTurn = async (agent) => (await request(`/api/messages?room=${gatherRoom}&limit=1&presence=active`, agent)).data.turn;
await gatherTurn('Claude');
let gather = await gatherTurn('GPT');
assert.equal(gather.next, null, 'No opener while agents gather');
assert.ok(gather.gather_until && gather.gather_seed);
const early = await request('/api/messages', 'Claude', { room: gatherRoom, message: 'Terlalu cepat', client_id: randomUUID(), last_seen_id: '0' });
assert.equal(early.status, 409);
const gatherDeadline = Date.now() + 40000;
while ((gather = await gatherTurn('Claude')).next === null) {
  assert.ok(Date.now() < gatherDeadline, 'Gathering window must end');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
gather = await gatherTurn('Gemini');
assert.equal(gather.probabilities.Gemini, 0, 'Late joiners miss the opener draw');
assert.ok(Math.abs(gather.probabilities.Claude - 0.5) < 0.0001 && Math.abs(gather.probabilities.GPT - 0.5) < 0.0001);
const gatherRoll = parseInt(createHash('sha256').update(`${gatherRoom}:0:${gather.gather_seed}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
assert.equal(gather.next, gatherRoll < 0.5 ? 'Claude' : 'GPT');
assert.equal((await request('/api/messages', gather.next, { room: gatherRoom, message: 'Pembuka', client_id: randomUUID(), last_seen_id: '0' })).status, 201);

const general = (await request('/api/messages?room=general', 'GPT')).data.messages;
assert.ok(general.every((message) => message.room === 'general'));
assert.ok((await request('/api/rooms', 'GPT')).data.rooms.some((item) => item.name === room));

// Rooms: only yeebyor creates them, explicitly or by sending; agents get 403 or 404.
const fresh = `${room}-new`;
assert.equal((await request('/api/rooms', 'GPT', { room: fresh })).status, 403, 'Agents cannot create rooms');
const agentSend = await request('/api/messages', 'GPT', { room: fresh, message: 'Room baru?', client_id: randomUUID(), last_seen_id: '0' });
assert.equal(agentSend.status, 404, 'Agents cannot create a room by sending to it');
assert.ok(!(await request('/api/rooms', 'GPT')).data.rooms.some((item) => item.name === fresh), 'The refused send left no room behind');
const createdRoom = await request('/api/rooms', 'yeebyor', { room: fresh });
assert.equal(createdRoom.status, 201);
assert.equal(createdRoom.data.room.name, fresh);
assert.equal(createdRoom.data.room.message_count, 0);
assert.equal(createdRoom.data.room.pinned, false);
assert.equal((await request('/api/rooms', 'yeebyor', { room: fresh })).data.room.created_at, createdRoom.data.room.created_at, 'Creating an existing room returns it unchanged');
assert.equal((await request('/api/rooms', 'yeebyor', { room: 'bad room' })).status, 422);
assert.equal((await request('/api/rooms', 'yeebyor', {})).status, 422);
let roomList = (await request('/api/rooms', 'Claude')).data.rooms;
const withMessages = roomList.find((item) => item.name === room);
assert.equal(withMessages.message_count, all.length, 'Room list counts messages');
assert.ok(withMessages.last_message_at, 'Room list carries the last message time');
const emptyRoom = roomList.find((item) => item.name === fresh);
assert.equal(emptyRoom.message_count, 0);
assert.equal(emptyRoom.last_message_at, null);
assert.equal(roomList.find((item) => item.name === 'general').pinned, true, 'general is pinned by default');
assert.equal(roomList.findIndex((item) => !item.pinned) > roomList.findLastIndex((item) => item.pinned), true, 'Pinned rooms come first');
assert.equal((await request('/api/rooms', 'GPT', { room, pinned: true }, {}, 'PATCH')).status, 403, 'Agents cannot pin');
assert.equal((await request('/api/rooms', 'yeebyor', { room, pinned: 'yes' }, {}, 'PATCH')).status, 422);
assert.equal((await request('/api/rooms', 'yeebyor', { room: 'general', pinned: false }, {}, 'PATCH')).status, 422, 'general stays pinned');
assert.equal((await request('/api/rooms', 'yeebyor', { room: `${room}-missing`, pinned: true }, {}, 'PATCH')).status, 404);
assert.equal((await request('/api/rooms', 'yeebyor', { room, pinned: true }, {}, 'PATCH')).data.room.pinned, true);
roomList = (await request('/api/rooms', 'Claude')).data.rooms;
assert.ok(roomList.find((item) => item.name === room).pinned);
assert.ok(roomList.findIndex((item) => item.name === room) < roomList.findIndex((item) => item.name === fresh), 'Pinned room outranks the newer unpinned room');
assert.equal((await request('/api/rooms', 'yeebyor', { room, pinned: false }, {}, 'PATCH')).data.room.pinned, false);

// Rename and delete: yeebyor only, general protected, refused while agents are present.
const before1 = `${room}-ren`;
const after1 = `${room}-ren2`;
assert.equal((await request('/api/rooms', 'yeebyor', { room: before1 })).status, 201);
assert.equal((await request('/api/messages', 'yeebyor', { room: before1, message: 'Sebelum ganti nama', client_id: randomUUID() })).status, 201);
assert.equal((await request('/api/rooms', 'GPT', { room: before1, name: after1 }, {}, 'PATCH')).status, 403, 'Agents cannot rename');
assert.equal((await request(`/api/rooms?room=${before1}`, 'GPT', undefined, {}, 'DELETE')).status, 403, 'Agents cannot delete');
assert.equal((await request('/api/rooms', 'yeebyor', { room: before1, name: after1, pinned: true }, {}, 'PATCH')).status, 422, 'Pin and rename are separate requests');
assert.equal((await request('/api/rooms', 'yeebyor', { room: before1 }, {}, 'PATCH')).status, 422);
assert.equal((await request('/api/rooms', 'yeebyor', { room: 'general', name: after1 }, {}, 'PATCH')).status, 422, 'general cannot be renamed');
assert.equal((await request('/api/rooms?room=general', 'yeebyor', undefined, {}, 'DELETE')).status, 422, 'general cannot be deleted');
assert.equal((await request('/api/rooms', 'yeebyor', undefined, {}, 'DELETE')).status, 422, 'Delete needs a room');
assert.equal((await request('/api/rooms', 'yeebyor', { room: `${room}-missing`, name: after1 }, {}, 'PATCH')).status, 404);
assert.equal((await request(`/api/rooms?room=${room}-missing`, 'yeebyor', undefined, {}, 'DELETE')).status, 404);
assert.equal((await request('/api/rooms', 'yeebyor', { room: before1, name: room }, {}, 'PATCH')).status, 409, 'Name already used');
// An agent present in the room blocks rename and delete until it leaves.
assert.equal((await request(`/api/messages?room=${before1}&limit=1&presence=active`, 'GPT')).status, 200);
const busyRename = await request('/api/rooms', 'yeebyor', { room: before1, name: after1 }, {}, 'PATCH');
assert.equal(busyRename.status, 409);
assert.match(busyRename.data.error, /agent is still active/);
assert.equal((await request(`/api/rooms?room=${before1}`, 'yeebyor', undefined, {}, 'DELETE')).status, 409);
assert.equal((await request(`/api/messages?room=${before1}&limit=1&presence=left`, 'GPT')).status, 200);
const renamed = await request('/api/rooms', 'yeebyor', { room: before1, name: after1 }, {}, 'PATCH');
assert.equal(renamed.status, 200);
assert.equal(renamed.data.room.name, after1);
const moved = (await request(`/api/messages?room=${after1}`, 'Claude')).data.messages;
assert.equal(moved.length, 1, 'Messages follow the renamed room');
assert.equal(moved[0].message, 'Sebelum ganti nama');
assert.equal((await request(`/api/messages?room=${before1}`, 'Claude')).data.count, 0, 'The old name is empty');
roomList = (await request('/api/rooms', 'Claude')).data.rooms;
assert.ok(roomList.some((item) => item.name === after1) && !roomList.some((item) => item.name === before1));
const removed = await request(`/api/rooms?room=${after1}`, 'yeebyor', undefined, {}, 'DELETE');
assert.equal(removed.status, 200);
assert.deepEqual(removed.data, { deleted: after1, messages: 1 });
assert.equal((await request(`/api/messages?room=${after1}`, 'Claude')).data.count, 0, 'Deleted messages are gone');
assert.ok(!(await request('/api/rooms', 'Claude')).data.rooms.some((item) => item.name === after1));

// Realtime: signals only. A client holding just the publishable key and the secret topic
// hears that something changed, never what was said.
assert.equal((await request('/api/realtime')).status, 401, 'Realtime details need a session');
const live = await request('/api/realtime', 'GPT');
assert.equal(live.status, 200);
assert.ok(live.data.url && live.data.key && live.data.topic.startsWith('chat-'));
const signals = [];
const realtime = new RealtimeClient(`${live.data.url.replace(/^http/, 'ws')}/realtime/v1`, { params: { apikey: live.data.key } });
const channel = realtime.channel(live.data.topic, { config: { broadcast: { self: false }, private: false } });
channel.on('broadcast', { event: 'change' }, (message) => signals.push(message.payload));
const joined = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('TIMEOUT'), 10000);
  channel.subscribe((status) => { if (status !== 'JOINING') { clearTimeout(timer); resolve(status); } });
});
assert.equal(joined, 'SUBSCRIBED', 'Realtime channel joins with the publishable key');
const signalRoom = `${room}-rt`;
const heard = async (table, op) => {
  for (let i = 0; i < 40; i++) {
    if (signals.some((item) => item.table === table && item.op === op && item.room === signalRoom)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};
assert.equal((await request('/api/rooms', 'yeebyor', { room: signalRoom })).status, 201);
assert.ok(await heard('rooms', 'insert'), 'Creating a room is signalled');
const secretText = `rahasia-${randomUUID()}`;
assert.equal((await request('/api/messages', 'yeebyor', { room: signalRoom, message: secretText, client_id: randomUUID() })).status, 201);
assert.ok(await heard('messages', 'insert'), 'A new message is signalled');
assert.equal((await request('/api/rooms', 'yeebyor', { room: signalRoom, pinned: true }, {}, 'PATCH')).status, 200);
assert.ok(await heard('rooms', 'update'), 'Pinning is signalled');
assert.equal((await request(`/api/rooms?room=${signalRoom}`, 'yeebyor', undefined, {}, 'DELETE')).status, 200);
assert.ok(await heard('rooms', 'delete'), 'Deleting a room is signalled');
assert.ok(!JSON.stringify(signals).includes(secretText), 'Signals never carry message text');
await realtime.disconnect();

// Direct REST access with the publishable key must not reveal private tables or accept bad tokens.
const rpc = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/chat_read`, {
  method: 'POST', headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_token: 'invalid', p_room: room }),
});
assert.equal((await rpc.json()).code, '28000');
const direct = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages?select=*`, {
  headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY },
});
assert.ok(!direct.ok, 'Private messages are not exposed');
console.log(JSON.stringify({ status: 'PASS', room, checks: 'credentials, identities, idempotency, validation, turn-taking, @mentions, presence, listening, empty-room gathering, @yeebyor wait, leave, lone agent, room create (owner only), activity, pins, rename, delete, realtime signals, stale replies, exact last_seen, stop phrase (whole message), per-discussion reset, concurrency, pagination, room isolation, private database access' }));
console.log(`Browser verification: ${base}/?room=${room}`);
