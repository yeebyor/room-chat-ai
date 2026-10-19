// Token usage of an agent's own session, read from the log its tool keeps on this machine.
//
// The server never calls a model, so the only place the numbers exist is each tool's session
// log: Claude Code (~/.claude/projects/*/<session>.jsonl), Codex (~/.codex/sessions/**/rollout-*-
// <thread>.jsonl) and Antigravity (~/.gemini/antigravity-cli/brain/<conversation>/...). Only the
// token counts and their times are read, never the text. In all three the figures mean the same:
//   input   = tokens the model read for the first time (including cache writes)
//   cached  = tokens it read again from the prompt cache
//   output  = tokens it wrote
// Every model request becomes one event with its time, so "what the session used since T" is
// a sum over the events from T on, with no snapshot to lose. A log is read once, then only what
// was appended since (a session log can be large).
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
const time = (value) => { const t = Date.parse(value); return Number.isNaN(t) ? 0 : t; };

// Each tool turns its log into events: {t, input, cached, output} per model request.
const TOOLS = {
  claude: {
    find: findClaude,
    make: () => ({ offset: 0, byId: new Map() }),
    // One message can span several lines with the same id; the last line has the final counts.
    onLine: (state, line) => {
      const o = parse(line);
      const usage = o?.message?.usage;
      const id = o?.message?.id;
      if (usage && id) {
        state.byId.set(id, { t: time(o.timestamp), input: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0), cached: usage.cache_read_input_tokens || 0, output: usage.output_tokens || 0 });
      }
    },
    events: (state) => [...state.byId.values()],
  },
  codex: {
    find: findCodex,
    make: () => ({ offset: 0, events: [], previous: null }),
    // total_token_usage is cumulative and its input includes the cached part, so a request is the
    // difference from the total before it.
    onLine: (state, line) => {
      if (!line.includes('"token_count"')) return;
      const o = parse(line);
      const total = o?.payload?.info?.total_token_usage;
      if (!total) return;
      const before = state.previous && total.input_tokens >= state.previous.input_tokens ? state.previous : { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
      state.previous = total;
      const input = (total.input_tokens || 0) - (before.input_tokens || 0);
      const cached = (total.cached_input_tokens || 0) - (before.cached_input_tokens || 0);
      const output = (total.output_tokens || 0) - (before.output_tokens || 0);
      if (input || output) state.events.push({ t: time(o.timestamp), input: Math.max(0, input - cached), cached: Math.max(0, cached), output: Math.max(0, output) });
    },
    events: (state) => state.events,
  },
  antigravity: {
    find: findAntigravity,
    make: () => ({ offset: 0, events: [] }),
    onLine: (state, line) => {
      if (!line.includes('_tokens')) return;
      const o = parse(line);
      if (o && (o.input_tokens || o.output_tokens)) state.events.push({ t: time(o.created_at), input: o.input_tokens || 0, cached: o.cache_read_tokens || 0, output: o.output_tokens || 0 });
    },
    events: (state) => state.events,
  },
};

const cache = new Map();

// What a session used from `since` (milliseconds since the epoch, 0 for all of it) on:
// {input, cached, output, at}, where at is when its log last changed. Null when the log is not on
// this machine.
export function sessionUsage(tool, session, since = 0, home = homedir()) {
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
  const sum = { input: 0, cached: 0, output: 0 };
  for (const event of spec.events(entry.state)) {
    if (event.t < since) continue;
    sum.input += event.input; sum.cached += event.cached; sum.output += event.output;
  }
  return { ...sum, at: stat.mtimeMs };
}

// When a room first involved an agent: the time of its first message there, or of the first
// message that names it with @, whichever is earlier. Used for a session that was already standing
// by before the join time was recorded, so its count includes the work done in the room.
export function firstInvolved(messages, agent) {
  const mention = new RegExp(`@${agent}(?![A-Za-z0-9_])`, 'i');
  let first = null;
  for (const message of messages) {
    if (message.sender !== agent && !mention.test(message.message)) continue;
    const at = Date.parse(message.created_at);
    if (!Number.isNaN(at) && (first === null || at < first)) first = at;
  }
  return first;
}
