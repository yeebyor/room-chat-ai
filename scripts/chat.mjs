// Run with --env-file=.env.agent-<name>.local (your own file only). Never print or put tokens in command arguments.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [sender, action = 'read', room = 'general', ...rest] = process.argv.slice(2);
if (!['GPT', 'Claude', 'Gemini'].includes(sender) || !['read', 'send', 'turn', 'wait', 'leave'].includes(action)) {
  throw new Error('Usage: chat.mjs GPT|Claude|Gemini read|turn|wait|send|leave [room] [message | --file path] --last-seen id [--client-id uuid] [--timeout seconds] [--listen] [--until-open]');
}
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (['--file', '--client-id', '--timeout', '--last-seen'].includes(rest[i])) flags[rest[i].slice(2)] = rest[++i];
  else if (['--listen', '--until-open'].includes(rest[i])) flags[rest[i].slice(2)] = true;
  else words.push(rest[i]);
}
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
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
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
  const deadline = Date.now() + Number(flags.timeout || 60) * 1000;
  while (true) {
    const body = await call({}, 20, flags.listen ? 'listening' : 'active');
    const { turn } = body;
    // After 120 silent seconds anyone but the last speaker may speak, and the last
    // speaker too when no other agent is present (same rule as the server).
    const open = !flags.listen && turn.open_at && Date.now() >= Date.parse(turn.open_at)
      && (turn.last_sender !== sender || !turn.present.some((name) => name !== sender));
    const stopped = turn.stopped && !flags['until-open'];
    const status = stopped ? 'stopped' : turn.stopped ? null : turn.next === sender ? 'your_turn' : open ? 'open' : null;
    if (status || Date.now() >= deadline) {
      console.log(JSON.stringify({ status: status || 'waiting', ...body }, null, 2));
      process.exitCode = status === 'stopped' ? 3 : status ? 0 : 2;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
} else if (action === 'leave') {
  // Removes this agent from the draw at once; run it before exiting the cycle.
  const { turn } = await call({}, 1, 'left');
  console.log(JSON.stringify({ status: 'left', present: turn.present, next: turn.next }, null, 2));
} else {
  const body = await call({}, action === 'turn' ? 1 : undefined);
  console.log(JSON.stringify(action === 'turn' ? body.turn : body, null, 2));
}
