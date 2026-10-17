// Wakes a sleeping agent. Used by `chat.mjs wait` and `hfma.mjs next` with `--wake codex`.
//
// An agent sleeps by running a long wait in the background and ending its turn. Some tools
// wake the agent when that command exits (Claude Code, Antigravity). Codex does not: the
// command ends and nobody tells the model. So the command tells it itself: when it is done it
// queues a message into the agent's own Codex session (`codex queue`), and that message
// starts a new turn. Nothing here costs tokens until the message arrives.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_RESULT = 1500;

// The real codex binary. CODEX_BIN wins; otherwise it is found under the package that runs
// this session (CODEX_MANAGED_PACKAGE_ROOT); otherwise `codex` on PATH. The binary is run
// directly, not through a .cmd shim, so a path with a space or a message with quotes is safe.
export function codexBinary(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const found = env.CODEX_MANAGED_PACKAGE_ROOT && findNative(join(env.CODEX_MANAGED_PACKAGE_ROOT, 'node_modules'), 6);
  return found || 'codex';
}

function findNative(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return null;
  const names = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name) && dir.endsWith('bin')) return path;
    if (entry.isDirectory()) {
      const inner = findNative(path, depth - 1);
      if (inner) return inner;
    }
  }
  return null;
}

// What the woken agent reads: one short paragraph, never the whole room.
export function wakeMessage(command, result, hint) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  const shown = text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)} ...(cut)` : text;
  return `WAKE: your background ${command} finished. Result: ${shown} ${hint}`;
}

// Queues the message into this agent's own Codex session. Returns an error text, or null.
// A failure never stops the command: its output is already printed. But the command runs in
// the background, where nobody reads its output, so a failure is also written to
// room-chat-ai-wake.log in the temp folder. Without that an agent that is never woken would
// sleep for good and nothing would say why.
export function wakeCodex(message, env = process.env) {
  const thread = env.CODEX_THREAD_ID;
  if (!thread) return Promise.resolve('--wake codex needs CODEX_THREAD_ID, which only Codex sets: run this command from a Codex session.');
  return new Promise((resolve) => {
    execFile(codexBinary(env), ['queue', '--thread', thread, '--message', message],
      { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve(null);
        const text = `Could not wake Codex: ${(stderr || error.message).trim().slice(0, 300)}`;
        try { appendFileSync(join(env.WAKE_GUARD_DIR || tmpdir(), 'room-chat-ai-wake.log'), `${new Date().toISOString()} thread ${thread} ${text.replace(/s+/g, ' ')}
`); } catch { /* the log must never break a wake */ }
        resolve(text);
      });
  });
}

// Loop guard. A wake costs tokens, so a wake that keeps repeating must stop. If the same
// result wakes an agent more than MAX_SAME times within WINDOW_MS (it was woken, did nothing
// that changed it, slept, and was woken by the same thing), the next wake is replaced by one
// last message telling the agent to stop and report to yeebyor, and that result stays silent
// for COOLDOWN_MS. A different result (a real new event) still gets through. More than
// MAX_ANY wakes of any kind within the window trips it the same way. The record is a small
// file in the temp folder, one per Codex session, because every wait is a new process.
const WINDOW_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_SAME = 3;
const MAX_ANY = 12;

function guardFile(env) {
  return join(env.WAKE_GUARD_DIR || tmpdir(), `room-chat-ai-wake-${String(env.CODEX_THREAD_ID).replace(/[^A-Za-z0-9-]/g, '')}.json`);
}

// Same contract as wakeCodex: returns a text to report (an error or a suppressed wake), or null.
export async function guardedWake(key, message, env = process.env, now = Date.now()) {
  if (!env.CODEX_THREAD_ID) return wakeCodex(message, env);
  const file = guardFile(env);
  let state = { wakes: [], tripped: {} };
  try { state = { wakes: [], tripped: {}, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* first wake */ }
  state.wakes = state.wakes.filter((wake) => now - wake.t < WINDOW_MS);
  state.tripped = Object.fromEntries(Object.entries(state.tripped).filter(([, until]) => until > now));
  const save = () => { try { writeFileSync(file, JSON.stringify(state)); } catch { /* the guard must never break a wake */ } };

  if (state.tripped[key]) {
    save();
    return 'Loop guard: this result already woke the agent repeatedly, so it is not waking it again for a while.';
  }
  const same = state.wakes.filter((wake) => wake.key === key).length;
  let outgoing = message;
  if (same >= MAX_SAME || state.wakes.length >= MAX_ANY) {
    state.tripped[key] = now + COOLDOWN_MS;
    const count = same >= MAX_SAME ? same : state.wakes.length;
    outgoing = `LOOP GUARD: you were woken ${count} times in the last 10 minutes ${same >= MAX_SAME ? 'with the same result' : 'in quick succession'} and nothing changed. `
      + 'Do NOT run wait or next again and do not start another background wait. Tell yeebyor in this window that you are stuck, '
      + `say what the last result was (${key.slice(0, 160)}), then wait for yeebyor's instructions.`;
  }
  state.wakes.push({ t: now, key });
  save();
  return wakeCodex(outgoing, env);
}
