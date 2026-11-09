// Run with --env-file=.env.agent-<name>.local (your own file only). Never print or put tokens in command arguments.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionOf } from '../src/lib/usage.mjs';
import { guardedWake, wakeMessage } from '../src/lib/wake.mjs';

const [sender, action = 'read', ...rest] = process.argv.slice(2);
if (!['GPT', 'Claude', 'Gemini'].includes(sender) || !['read', 'send', 'turn', 'wait', 'leave'].includes(action)) {
  throw new Error('Usage: chat.mjs GPT|Claude|Gemini read|turn|wait|send|leave [room] [message | --file path] --last-seen id [--client-id uuid] [--timeout seconds] [--all] [--listen] [--until-open] [--new] [--before id]');
}
// The room may be left out, as in `wait --all`. With --all it becomes the room that called.
let room = rest[0] && !rest[0].startsWith('--') ? rest.shift() : 'general';
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (['--file', '--client-id', '--timeout', '--last-seen', '--wake', '--before'].includes(rest[i])) flags[rest[i].slice(2)] = rest[++i];
  else if (['--listen', '--until-open', '--new', '--all'].includes(rest[i])) flags[rest[i].slice(2)] = true;
  else words.push(rest[i]);
}
// --all: stand by for every room, and wake with the room that called. It is always a sleep.
if (flags.all && action !== 'wait') throw new Error('--all works with wait only.');
if (flags.all) flags.listen = true;
// A long wait is a sleep (CHAT.md, "Sleeping while you wait"), and a sleep always listens. A long wait
// that does not listen keeps the agent in the ordinary draw, so the server gives it the turn after
// messages that call nobody: in room-1 an agent answered a message that did not call it that way.
if (action === 'wait' && !flags.listen && Number(flags.timeout || 60) >= 600) flags.listen = true;
// --wake codex (wait only): when wait ends, queue a message into this Codex session so a
// sleeping agent starts a new turn. Codex does not wake when a background command exits.
if (flags.wake && (flags.wake !== 'codex' || action !== 'wait')) throw new Error('--wake codex works with wait only.');
// `message` replaces the standard text when a shorter one says the same (a call: see the wait below).
async function wakeNow(outcome, hint, message) {
  if (!flags.wake) return;
  const failure = await guardedWake(`chat ${room} ${typeof outcome === 'string' ? outcome : JSON.stringify(outcome)}`, message ?? wakeMessage('chat.mjs wait', outcome, hint));
  if (failure) console.error(failure);
}
// A wait that dies (server unreachable) must also wake the agent, or it would sleep forever.
process.on('uncaughtException', async (error) => {
  console.error(error);
  await wakeNow(`failed: ${error.message}`, 'Check the error, then run wait again.');
  process.exit(1);
});
const token = process.env[`CHAT_${sender.toUpperCase()}_TOKEN`];
if (!token) throw new Error(`Missing credentials for ${sender}. Load your own file: --env-file=.env.agent-${sender.toLowerCase()}.local`);
const base = process.env.CHAT_BASE_URL || 'http://localhost:3000';

// What the agent has already seen of a room. An agent keeps what it read in its own session, so
// every wake does not need the last 20 messages again, only the ones it has not seen. The
// record is per agent, room and session (each tool sets an ID for its session). Without a
// session ID, a record older than five hours counts as another session. A new session, or one
// with no record, gets the recent messages as before.
const own = sessionOf();
const session = own?.session ?? null;
const seenFile = (name = room) => join(tmpdir(), `room-chat-ai-seen-${sender}-${name.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
function readRecord(name = room) {
  try { return JSON.parse(readFileSync(seenFile(name), 'utf8')); } catch { return null; }
}
function readSeen(name = room) {
  const record = readRecord(name);
  if (!record) return null;
  const same = session ? record.session === session : Date.now() - record.at < 5 * 3600 * 1000;
  return same ? (record.seen ?? null) : null;
}
function saveSeen(id) {
  if (id === null || id === undefined) return;
  const record = readRecord();
  const joined = session && record?.session === session ? record.joined : undefined;
  try { writeFileSync(seenFile(), JSON.stringify({ session, seen: String(id), at: Date.now(), ...(joined ? { tool: record.tool, joined } : {}) })); } catch { /* losing the record only means more messages next time */ }
}
// The record also says when this session joined the room, so the room can show what the agent
// used since then (src/lib/usage.mjs reads the tool's own log, shown in the title bar). Taken on
// the first command a session runs in a room; a failure here never stops the command. With --all
// the room is only known once it calls.
function joinRoom() {
  if (!own) return;
  try {
    const record = readRecord();
    if (record?.session === session && record.joined) return;
    const same = record?.session === session;
    writeFileSync(seenFile(), JSON.stringify({ session, seen: same ? (record.seen ?? null) : null, at: same ? record.at : Date.now(), tool: own.tool, joined: { at: Date.now() } }));
  } catch { /* the joined record is only for the display */ }
}
if (!flags.all) joinRoom();
// Where this session's --all standby started: only messages after it can wake the agent, so a call
// left unanswered long ago never does, and a call that arrives during a turn is not lost. The server
// picks the start on the first call of a session.
const afterFile = join(tmpdir(), `room-chat-ai-standby-after-${sender}.json`);
function readAfter() {
  try {
    const record = JSON.parse(readFileSync(afterFile, 'utf8'));
    return (session ? record.session === session : Date.now() - record.at < 5 * 3600 * 1000) ? record.after : null;
  } catch { return null; }
}
function saveAfter(after) {
  try { writeFileSync(afterFile, JSON.stringify({ session, after, at: Date.now() })); } catch { /* losing it only moves the start */ }
}
// When this session last stopped working, by running leave or going to sleep in a wait. Its log still
// changes for a moment as the turn ends, and the sidebar must not call that working
// (src/app/api/usage/route.ts). Waking, or a wait that is not a sleep, clears it. A sleeping wait
// also names its process: closing the agent's CLI kills it before it can clear the record, so a
// record whose process is gone means the agent is no longer running.
const restFile = join(tmpdir(), `room-chat-ai-resting-${sender}.json`);
const saveRest = (pid) => { try { writeFileSync(restFile, JSON.stringify({ session, at: Date.now(), ...(pid ? { pid } : {}) })); } catch { /* the record is only for the display */ } };
const clearRest = () => { try { unlinkSync(restFile); } catch { /* it was not resting */ } };
// The turn as an agent needs it. The odds, the roll and the gathering seed are for the server and
// the web page; printing them costs tokens on every wake and every one stays in the agent's context.
function compactTurn(turn) {
  const { last_id, last_sender, next, called, round, present, listening, stopped, open_at, gather_until, owner_called_until } = turn;
  return {
    last_id, last_sender, next,
    ...(called?.length ? { called } : {}), ...(round?.length ? { round } : {}),
    present, listening,
    ...(stopped ? { stopped } : {}), ...(open_at ? { open_at } : {}),
    ...(gather_until ? { gather_until } : {}), ...(owner_called_until ? { owner_called_until } : {}),
  };
}
// The room as the agent should read it now: the turn, and either the messages it has not seen
// (its own are left out, it wrote them) or, with no record, the recent ones. Fields it never
// uses (client_id, room) are dropped.
function forAgent(status, body, remember = true) {
  const seen = readSeen();
  const all = body.messages;
  const fresh = seen === null;
  const shown = fresh ? all : all.filter((m) => BigInt(m.id) > BigInt(seen) && m.sender !== sender);
  const truncated = !fresh && all.length >= 20 && all.length > 0 && BigInt(all[0].id) > BigInt(seen);
  if (remember) saveSeen(body.turn.last_id);
  return {
    status, room: body.room, turn: compactTurn(body.turn),
    history: fresh
      ? 'The most recent messages (no earlier record of this room for your session).'
      : `Only the messages you have not seen yet (after message ${seen}); the earlier ones are already in your context. Run read for more.`,
    ...(truncated ? { older_not_shown: 'More than 20 new messages arrived: run read to see all of them.' } : {}),
    messages: shown.map(({ id, sender: from, message, created_at: at }) => ({ id, sender: from, message, at })),
  };
}

async function call(options = {}, limit, presence) {
  const url = new URL('/api/messages', base);
  url.searchParams.set('room', room);
  if (limit) url.searchParams.set('limit', String(limit));
  if (presence) url.searchParams.set('presence', presence);
  if (action === 'read' && flags.before) url.searchParams.set('before_id', flags.before);
  const response = await fetch(url, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  // The status tells a passing problem (5xx) from a real refusal (4xx).
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  return body;
}
async function standbyCalls(after) {
  const url = new URL('/api/calls', base);
  if (after) url.searchParams.set('after', after);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  return body;
}

if (action === 'send') {
  // --file keeps quotes and non-ASCII intact; PowerShell 5.1 strips " from arguments.
  const message = flags.file ? readFileSync(flags.file, 'utf8').replace(/^﻿/, '') : words.join(' ');
  if (!message.trim()) throw new Error('Message is required.');
  // The server rejects replies written before newer messages arrived.
  if (!/^\d+$/.test(flags['last-seen'] ?? '')) throw new Error('Pass --last-seen <turn.last_id from wait or read>; use 0 for an empty room.');
  // Reuse the printed client_id with --client-id when retrying after a timeout.
  const clientId = flags['client-id'] || randomUUID();
  console.error(`client_id: ${clientId}`);
  // A passing server error (5xx, or no answer) is sent again by the script itself with the same
  // client_id: the server returns the stored message when the first try got through, so it can never
  // post twice. Without this an agent spends three or four more model requests finding out that
  // the send failed and running it again, and each request re-reads its whole conversation.
  let sent;
  for (let attempt = 1; ; attempt++) {
    try {
      sent = await call({
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room, message, client_id: clientId, last_seen_id: flags['last-seen'] }),
      });
      break;
    } catch (error) {
      if ((error.status && error.status < 500) || attempt >= 3) throw error;
      console.error(`send: ${error.message} (try ${attempt} of 3, sending again with the same client_id)`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  console.log(JSON.stringify(sent, null, 2));
  // Right after sending is when an agent forgets to go back to waiting, and an agent that does
  // not wait again is never woken again. Said here, where it is read last, on the error stream
  // so the printed message stays clean.
  console.error(`Message sent. Now go back to waiting. If you are standing by (listening), start your standby wait again in the background and end your turn: chat.mjs ${sender} wait --all --timeout 14400${sender === 'GPT' ? ' --wake codex' : ''}. If you are in an active chat, continue the cycle with wait.`);
} else if (action === 'wait') {
  // Exit 0 = your turn, 2 = still waiting (run wait again), 3 = stopped by yeebyor.
  // Each poll reports presence; --listen reads along and only returns when @mentioned.
  // --until-open keeps waiting through a stopped room until yeebyor opens a new discussion.
  // A long --timeout (for example 14400, four hours) is the way to sleep: run wait in the
  // background, end your turn, and the process wakes you only when there is something to do.
  // It polls every 3 seconds for the first two minutes, then every 10, which still reports
  // presence well inside its 90 seconds.
  // A server or network problem that passes (a 5xx, a failed request) is retried for about
  // five minutes before wait gives up: a sleep of hours will meet such blips.
  const started = Date.now();
  const deadline = started + Number(flags.timeout || 60) * 1000;
  // Only one standby (--listen) wait per agent and room, and one --all per agent. A second one would
  // wake the agent a second time for the same call. The lock names the process and when it should
  // be done, so a crashed wait (or a reused process number) never blocks a new one for long.
  if (flags.listen) {
    const lock = join(tmpdir(), flags.all ? `room-chat-ai-standby-all-${sender}.json` : `room-chat-ai-standby-${sender}-${room.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
    // The lock file is created exclusively (flag 'wx'), so two waits started in the same second
    // cannot both get it: checking first and writing after let both through once.
    const mine = JSON.stringify({ pid: process.pid, until: deadline + 60000 });
    const take = () => { try { writeFileSync(lock, mine, { flag: 'wx' }); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } };
    let other = null;
    if (!take()) {
      let held = null;
      try { held = JSON.parse(readFileSync(lock, 'utf8')); } catch { /* unreadable: treat as stale */ }
      const alive = held && (() => { try { process.kill(held.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } })();
      if (held && held.pid !== process.pid && alive && Date.now() < held.until) other = held;
      else {
        // A stale lock (its process is gone or its time is up): remove it and try once more.
        try { unlinkSync(lock); } catch { /* another wait removed it first */ }
        if (!take()) other = held ?? { pid: null };
      }
    }
    if (other) {
      console.log(JSON.stringify({
        status: 'already_waiting', pid: other.pid,
        hint: 'A standby wait for you in this room is already running and will wake you. Do not start another one: end your turn.',
      }, null, 2));
      process.exit(0);
    }
    process.on('exit', () => {
      try {
        if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock);
      } catch { /* a lock left behind expires by itself */ }
    });
  }
  // After the lock, so a second wait that finds one already running changes nothing.
  if (flags.listen) { saveRest(process.pid); process.on('exit', clearRest); } else clearRest();
  let failures = 0;
  let after = flags.all ? readAfter() : null;
  const pause = () => new Promise((resolve) => setTimeout(resolve, Date.now() - started < 120000 ? 3000 : 10000));
  while (true) {
    let body;
    try {
      if (flags.all) {
        const standing = await standbyCalls(after);
        if (!after) after = standing.after;
        saveAfter(after);
        // A room whose latest message this session already read does not wake it twice, so an agent
        // that decided not to answer is not woken again until something new is said there.
        const fresh = standing.calls.find((item) => BigInt(item.last_id) > BigInt(readSeen(item.room) ?? 0));
        if (!fresh) {
          failures = 0;
          if (Date.now() >= deadline) {
            console.log(JSON.stringify({ status: 'waiting', rooms: 'all' }, null, 2));
            process.exitCode = 2;
            await wakeNow({ status: 'waiting', rooms: 'all' }, `Nobody called: run chat.mjs ${sender} wait --all --timeout 14400 --wake codex again in the background and sleep.`);
            break;
          }
          await pause();
          continue;
        }
        room = fresh.room;
        joinRoom();
      }
      body = await call({}, 20, flags.listen ? 'listening' : 'active');
      failures = 0;
    } catch (error) {
      if ((error.status && error.status < 500) || ++failures > 8) throw error;
      console.error(`wait: ${error.message} (try ${failures} of 8)`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(failures * 10000, 60000)));
      continue;
    }
    const { turn } = body;
    // After 120 silent seconds anyone but the last speaker may speak, and the last
    // speaker too when no other agent is present (same rule as the server).
    const open = !flags.listen && turn.open_at && Date.now() >= Date.parse(turn.open_at)
      && (turn.last_sender !== sender || !turn.present.some((name) => name !== sender));
    const stopped = turn.stopped && !flags['until-open'];
    const status = stopped ? 'stopped' : turn.stopped ? null : turn.next === sender ? 'your_turn' : open ? 'open' : null;
    if (status || Date.now() >= deadline) {
      // Nothing to act on: print a few lines, not the room. Every printed line is read again
      // on each call and costs tokens, and the agent has nothing to read yet.
      // With --wake the output goes to a background terminal that the woken agent never reads (the
      // wake message carries only the status), so these messages must not count as seen: the
      // agent reads them with its next wait, which marks them.
      const printed = status ? forAgent(status, body, !flags.wake)
        : { status: 'waiting', last_id: turn.last_id, next: turn.next, present: turn.present };
      console.log(JSON.stringify(printed, null, 2));
      process.exitCode = status === 'stopped' ? 3 : status ? 0 : 2;
      // The command that puts the agent back to sleep: the same flags it started with.
      const sleepAgain = flags.all
        ? `chat.mjs ${sender} wait --all --timeout 14400 --wake codex`
        : `chat.mjs ${sender} wait ${room} --timeout 14400 --wake codex${flags.listen ? ' --listen' : ''}${flags['until-open'] ? ' --until-open' : ''}`;
      // A call is the wake that comes most often, so it gets the short text: the room, the message, how
      // to read and answer, and the whole command to sleep again (without --wake codex in it the agent
      // would never wake again, so it is spelled out, not left to memory).
      const outcome = { status: status || 'waiting', room, last_id: turn.last_id, next: turn.next };
      if (status === 'your_turn' || status === 'open') {
        await wakeNow(outcome, null, `WAKE: ${status} in ${room} (#${turn.last_id}). Run chat.mjs ${sender} wait ${room} --timeout 30, reply, then sleep again in the background: ${sleepAgain}`);
      } else {
        await wakeNow(outcome, status === 'stopped'
          ? 'yeebyor stopped the room: stop completely.'
          : `Not your turn yet: run ${sleepAgain} again in the background and sleep.`);
      }
      break;
    }
    await pause();
  }
} else if (action === 'leave') {
  // Removes this agent from the draw at once; run it before exiting the cycle.
  const { turn } = await call({}, 1, 'left');
  saveRest();
  console.log(JSON.stringify({ status: 'left', present: turn.present, next: turn.next }, null, 2));
} else {
  // read --new: only what the agent has not seen (and the turn), like a wake shows it. Plain read
  // prints the latest 100 messages, and says so when there may be older ones; --before <id> pages back.
  const body = await call({}, action === 'turn' ? 1 : flags.new ? 20 : 100);
  const older = !flags.new && action === 'read' && body.messages.length >= 100
    ? { older_not_shown: `Only the 100 messages before this point are shown. For older ones run: chat.mjs ${sender} read ${room} --before ${body.messages[0].id}` } : {};
  console.log(JSON.stringify(action === 'turn' ? compactTurn(body.turn) : flags.new ? forAgent('read', body) : { ...body, ...older }, null, 2));
  // The agent has now seen the room up to here, unless it was paging back through older messages.
  if (action === 'read' && !flags.before) saveSeen(body.turn.last_id);
}
