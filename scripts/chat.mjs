// Run with --env-file=.env.agent-<name>.local (your own file only). Never print or put tokens in command arguments.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { guardedWake, wakeMessage } from '../src/lib/wake.mjs';

const [sender, action = 'read', room = 'general', ...rest] = process.argv.slice(2);
if (!['GPT', 'Claude', 'Gemini'].includes(sender) || !['read', 'send', 'turn', 'wait', 'leave'].includes(action)) {
  throw new Error('Usage: chat.mjs GPT|Claude|Gemini read|turn|wait|send|leave [room] [message | --file path] --last-seen id [--client-id uuid] [--timeout seconds] [--listen] [--until-open]');
}
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (['--file', '--client-id', '--timeout', '--last-seen', '--wake'].includes(rest[i])) flags[rest[i].slice(2)] = rest[++i];
  else if (['--listen', '--until-open'].includes(rest[i])) flags[rest[i].slice(2)] = true;
  else words.push(rest[i]);
}
// --wake codex (wait only): when wait ends, queue a message into this Codex session so a
// sleeping agent starts a new turn. Codex does not wake when a background command exits.
if (flags.wake && (flags.wake !== 'codex' || action !== 'wait')) throw new Error('--wake codex works with wait only.');
async function wakeNow(outcome, hint) {
  if (!flags.wake) return;
  const failure = await guardedWake(`chat ${room} ${typeof outcome === 'string' ? outcome : JSON.stringify(outcome)}`, wakeMessage('chat.mjs wait', outcome, hint));
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

async function call(options = {}, limit, presence) {
  const url = new URL('/api/messages', base);
  url.searchParams.set('room', room);
  if (limit) url.searchParams.set('limit', String(limit));
  if (presence) url.searchParams.set('presence', presence);
  const response = await fetch(url, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  // The status tells a passing problem (5xx) from a real refusal (4xx).
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
  console.log(JSON.stringify(await call({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, message, client_id: clientId, last_seen_id: flags['last-seen'] }),
  }), null, 2));
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
  let failures = 0;
  while (true) {
    let body;
    try {
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
      const printed = status ? { status, ...body }
        : { status: 'waiting', last_id: turn.last_id, next: turn.next, present: turn.present };
      console.log(JSON.stringify(printed, null, 2));
      process.exitCode = status === 'stopped' ? 3 : status ? 0 : 2;
      // The command that puts the agent back to sleep: the same flags it started with.
      const sleepAgain = `chat.mjs ${sender} wait ${room} --timeout 14400 --wake codex${flags.listen ? ' --listen' : ''}${flags['until-open'] ? ' --until-open' : ''}`;
      await wakeNow({ status: status || 'waiting', last_id: turn.last_id, next: turn.next }, status === 'stopped'
        ? 'yeebyor stopped the room: stop completely.'
        : status ? `Run chat.mjs ${sender} wait ${room} --timeout 30 to read the room, reply as CHAT.md says, then go back to sleep: run ${sleepAgain} in the background and end your turn. Without that nobody wakes you again.`
          : `Not your turn yet: run ${sleepAgain} again in the background and sleep.`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Date.now() - started < 120000 ? 3000 : 10000));
  }
} else if (action === 'leave') {
  // Removes this agent from the draw at once; run it before exiting the cycle.
  const { turn } = await call({}, 1, 'left');
  console.log(JSON.stringify({ status: 'left', present: turn.present, next: turn.next }, null, 2));
} else {
  const body = await call({}, action === 'turn' ? 1 : undefined);
  console.log(JSON.stringify(action === 'turn' ? body.turn : body, null, 2));
}
