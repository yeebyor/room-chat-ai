// Token usage of an agent's own session, read from the log its tool keeps on this machine.
//
// The server never calls a model, so the only place the numbers exist is each tool's session
// log: Claude Code (~/.claude/projects/*/<session>.jsonl), Codex (~/.codex/sessions/**/rollout-*-
// <thread>.jsonl) and Antigravity (~/.gemini/antigravity-cli/brain/<conversation>/...). Only the
// token counts are read, never the text. In all three the figures mean the same:
//   input   = tokens the model read for the first time (including cache writes)
//   cached  = tokens it read again from the prompt cache
//   output  = tokens it wrote
// A log is read once, then only what was appended since (a session log can be large).
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = /^[A-Za-z0-9_-]{6,80}$/;

// Which tool runs this process and which of its sessions, from the variables each tool sets.
export function sessionOf(env = process.env) {
  if (env.CODEX_THREAD_ID) return { tool: 'codex', session: env.CODEX_THREAD_ID };
  if (env.CLAUDE_CODE_SESSION_ID) return { tool: 'claude', session: env.CLAUDE_CODE_SESSION_ID };
  if (env.ANTIGRAVITY_CONVERSATION_ID) return { tool: 'antigravity', session: env.ANTIGRAVITY_CONVERSATION_ID };
  return null;
}

function findClaude(session, home) {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${session}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

function findCodex(session, home) {
  const walk = (dir, depth) => {
    if (depth < 0 || !existsSync(dir)) return null;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(`-${session}.jsonl`)) return path;
      if (entry.isDirectory()) {
        const inner = walk(path, depth - 1);
        if (inner) return inner;
      }
    }
    return null;
  };
  return walk(join(home, '.codex', 'sessions'), 4);
}

function findAntigravity(session, home) {
  const file = join(home, '.gemini', 'antigravity-cli', 'brain', session, '.system_generated', 'logs', 'transcript_full.jsonl');
  return existsSync(file) ? file : null;
}

// Reads the complete lines appended since the last call. state.offset is the start of the first
// line not yet processed, so a line still being written is read again next time.
function scan(file, state, onLine) {
  const size = statSync(file).size;
  let position = state.offset;
  if (position >= size) return;
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    let carry = Buffer.alloc(0);
    while (position < size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (read <= 0) break;
      position += read;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      const end = data.lastIndexOf(10);
      if (end < 0) { carry = Buffer.from(data); continue; }
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) if (line) onLine(line);
      carry = Buffer.from(data.subarray(end + 1));
      state.offset = position - carry.length;
    }
  } finally { closeSync(fd); }
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

const TOOLS = {
  claude: {
    find: findClaude,
    make: () => ({ offset: 0, byId: new Map() }),
    // One message can span several lines with the same id; the last line has the final counts.
    onLine: (state, line) => {
      const o = parse(line);
      const usage = o?.message?.usage;
      const id = o?.message?.id;
      if (usage && id) state.byId.set(id, [(usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0), usage.cache_read_input_tokens || 0, usage.output_tokens || 0]);
    },
    total: (state) => {
      const sum = { input: 0, cached: 0, output: 0 };
      for (const [input, cached, output] of state.byId.values()) { sum.input += input; sum.cached += cached; sum.output += output; }
      return sum;
    },
  },
  codex: {
    find: findCodex,
    make: () => ({ offset: 0, last: null }),
    // total_token_usage is cumulative and its input includes the cached part.
    onLine: (state, line) => {
      if (!line.includes('"token_count"')) return;
      const total = parse(line)?.payload?.info?.total_token_usage;
      if (total) state.last = total;
    },
    total: (state) => {
      const t = state.last;
      return t ? { input: Math.max(0, (t.input_tokens || 0) - (t.cached_input_tokens || 0)), cached: t.cached_input_tokens || 0, output: t.output_tokens || 0 } : { input: 0, cached: 0, output: 0 };
    },
  },
  antigravity: {
    find: findAntigravity,
    make: () => ({ offset: 0, input: 0, cached: 0, output: 0 }),
    onLine: (state, line) => {
      if (!line.includes('_tokens')) return;
      const o = parse(line);
      if (!o) return;
      state.input += o.input_tokens || 0;
      state.cached += o.cache_read_tokens || 0;
      state.output += o.output_tokens || 0;
    },
    total: (state) => ({ input: state.input, cached: state.cached, output: state.output }),
  },
};

const cache = new Map();

// {input, cached, output, at} for a session (at = when its log last changed), or null when the
// log is not on this machine.
export function sessionUsage(tool, session, home = homedir()) {
  const spec = TOOLS[tool];
  if (!spec || !SESSION.test(session ?? '')) return null;
  const key = `${tool}:${session}:${home}`;
  let entry = cache.get(key);
  if (!entry || !existsSync(entry.file)) {
    const file = spec.find(session, home);
    if (!file) return null;
    entry = { file, state: spec.make() };
    cache.set(key, entry);
  }
  const stat = statSync(entry.file);
  if (stat.size < entry.state.offset) entry.state = spec.make();
  scan(entry.file, entry.state, (line) => spec.onLine(entry.state, line));
  return { ...spec.total(entry.state), at: stat.mtimeMs };
}

// What a session used since a snapshot of it (never below zero).
export function usageSince(now, base) {
  const part = (key) => Math.max(0, (now?.[key] || 0) - (base?.[key] || 0));
  return { input: part('input'), cached: part('cached'), output: part('output') };
}
