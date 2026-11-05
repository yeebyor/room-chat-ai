// npm test: every check that needs no Supabase project and no real agent. supabase/schema.sql runs in
// an in-memory Postgres (PGlite), a small bridge answers the RPC calls the app makes to Supabase, and
// the real app runs through `npm run dev` with throwaway tokens. Nothing reaches a live database,
// because environment variables win over .env.local. Realtime is the one thing it cannot cover.
// Stop your own `npm run dev` first: Next allows one dev server per folder.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const repo = fileURLToPath(new URL('..', import.meta.url));
const SUITES = ['smoke-usage', 'smoke-cli', 'smoke-chat', 'smoke-hfma', 'smoke-standby', 'smoke-hfma-git'];
const failures = [];
function check(name, ok, seen) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${seen})`}`);
  if (!ok) failures.push(name);
}

// --- The schema itself: a fresh install has to work, and shows no room to the public.
const db = new PGlite();
await db.exec('create role anon; create role authenticated;');
try {
  await db.exec(readFileSync(join(repo, 'supabase/schema.sql'), 'utf8'));
  check('schema.sql installs on an empty database', true);
} catch (error) {
  check('schema.sql installs on an empty database', false, error.message);
  process.exit(1);
}
const showcase = await db.query(`select public.showcase_read('general')`).then(() => 'readable').catch((error) => error.code);
check('a fresh install shows no room without a token', showcase === 'P0002', showcase);

const tokens = { CHAT_USER_TOKEN: 'yeebyor', CHAT_CLAUDE_TOKEN: 'Claude', CHAT_GPT_TOKEN: 'GPT', CHAT_GEMINI_TOKEN: 'Gemini' };
const fake = {};
for (const [name, sender] of Object.entries(tokens)) {
  fake[name] = randomBytes(32).toString('hex');
  await db.query(`insert into chat_private.credentials(token_hash, sender) values (encode(sha256(convert_to($1,'UTF8')),'hex'), $2)`, [fake[name], sender]);
}

// --- Stands in for Supabase: POST /rest/v1/rpc/<name> runs public.<name>, and errors look the same.
const bridge = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    res.setHeader('Content-Type', 'application/json');
    const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url);
    if (!match) { res.statusCode = 404; res.end('{"message":"not exposed"}'); return; }
    const args = JSON.parse(body || '{}');
    const keys = Object.keys(args).filter((key) => /^p_[a-z_]+$/.test(key));
    const values = keys.map((key) => (args[key] !== null && typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]));
    try {
      const result = await db.query(`select public.${match[1]}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) as r`, values);
      res.end(JSON.stringify(result.rows[0].r));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: error.code, details: error.detail ?? null, message: error.message }));
    }
  });
});
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));

const freePort = () => new Promise((resolve) => {
  const probe = createNetServer();
  probe.listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const port = await freePort();
const temp = mkdtempSync(join(tmpdir(), 'room-chat-test-'));
const env = {
  ...process.env, ...fake, SUPABASE_URL: `http://127.0.0.1:${bridge.address().port}`, SUPABASE_PUBLISHABLE_KEY: 'test-only',
  HFMA_WORK_ROOT: dirname(repo.replace(/[\\/]$/, '')), CHAT_BASE_URL: `http://localhost:${port}`, SMOKE_NO_REALTIME: '1',
  NEXT_TELEMETRY_DISABLED: '1', TEMP: temp, TMP: temp, TMPDIR: temp,
};

function request({ address = 'localhost', path, method = 'POST', headers = {}, body }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: address, port, path, method, timeout: 120000,
      headers: { Host: `${address}:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] ?? '' }));
    });
    req.on('error', (error) => resolve({ status: error.code ?? error.message, cookie: '' }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// --- The real app, started the way a person starts it.
const windows = process.platform === 'win32';
const app = spawn(`npm run dev -- --port ${port}`, { cwd: repo, env, shell: true, windowsHide: true, detached: !windows });
let log = '';
app.stdout.on('data', (chunk) => { log += chunk; });
app.stderr.on('data', (chunk) => { log += chunk; });
const stopApp = () => {
  if (windows) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F']);
  else { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* it already ended */ } }
};

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: repo, env, windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

try {
  for (let i = 0; ; i++) {
    const answer = await request({ path: '/api/session', body: {} });
    if (answer.status === 200 || answer.status === 401) break;
    if (app.exitCode !== null || i > 120) throw new Error(`The app did not start. If your own npm run dev is running, stop it first.\n${log.slice(-1500)}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // --- What only shows from outside the app.
  const session = await request({ path: '/api/session', body: {} });
  check('npm run dev opens without a login on this computer', session.status === 200 && session.cookie.includes(fake.CHAT_USER_TOKEN), session.status);
  const network = Object.values(networkInterfaces()).flat().find((item) => item.family === 'IPv4' && !item.internal)?.address;
  if (network) {
    const outside = await request({ address: network, path: '/api/session', body: {} });
    check('npm run dev cannot be reached from the network', !outside.cookie && outside.status !== 200, outside.status);
  }
  const evidence = (output) => request({ path: '/api/hfma', headers: { Authorization: `Bearer ${fake.CHAT_CLAUDE_TOKEN}` },
    body: { op: 'evidence_add', args: { room: 'no-such-room', task: '1', kind: 'submit', commit: 'a'.repeat(40), command: 'x', exit_code: 0, timed_out: false, duration_ms: 1, output } } });
  const allowed = await evidence('█'.repeat(16000));
  check('the longest allowed test output reaches the database', allowed.status === 404, allowed.status);
  const tooLarge = await evidence('x'.repeat(200000));
  check('a request far over any allowed size is refused', tooLarge.status === 413, tooLarge.status);

  // --- The smoke tests, one at a time because they share the app.
  for (const suite of SUITES) {
    const { code, out } = await run(join(repo, 'scripts', `${suite}.mjs`));
    check(suite, code === 0, `exit ${code}\n${out.slice(-2500)}`);
  }
} catch (error) {
  check('the test run', false, error.message);
} finally {
  stopApp();
  bridge.close();
  rmSync(temp, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll passed.');
process.exit(failures.length ? 1 : 0);
