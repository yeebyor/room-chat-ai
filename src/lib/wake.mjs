// Wakes a sleeping agent. Used by `chat.mjs wait` and `hfma.mjs next` with `--wake codex`.
//
// An agent sleeps by running a long wait in the background and ending its turn. Some tools
// wake the agent when that command exits (Claude Code, Antigravity). Codex does not: the
// command ends and nobody tells the model. So the command tells it itself: when it is done it
// queues a message into the agent's own Codex session (`codex queue`), and that message
// starts a new turn. Nothing here costs tokens until the message arrives.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
// A failure is reported but never stops the command: its output is already printed, and the
// agent will read it the next time it is woken or asked.
export function wakeCodex(message, env = process.env) {
  const thread = env.CODEX_THREAD_ID;
  if (!thread) return Promise.resolve('--wake codex needs CODEX_THREAD_ID, which only Codex sets: run this command from a Codex session.');
  return new Promise((resolve) => {
    execFile(codexBinary(env), ['queue', '--thread', thread, '--message', message],
      { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
        resolve(error ? `Could not wake Codex: ${(stderr || error.message).trim().slice(0, 300)}` : null);
      });
  });
}
