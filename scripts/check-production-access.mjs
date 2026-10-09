import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.CHAT_PRODUCTION_TEST_URL || 'http://127.0.0.1:3011';
async function session(body, cookie) {
  return fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
}
assert.equal((await session({})).status, 401, 'Production cannot auto-login on loopback');
assert.equal((await session({ token: 'invalid' })).status, 401);
const login = await session({ token: process.env.CHAT_USER_TOKEN });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie');
assert.ok(cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=strict'));
const cookieHeader = cookie.split(';')[0];
assert.equal((await session({}, cookieHeader)).status, 200, 'Existing sessions survive reload');
const health = await fetch(`${base}/api/health`, { headers: { Cookie: cookieHeader } });
assert.equal(health.status, 200);
assert.equal((await fetch(`${base}/api/health`)).status, 401);

const secrets = ['CHAT_USER_TOKEN', 'CHAT_GPT_TOKEN', 'CHAT_CLAUDE_TOKEN', 'CHAT_GEMINI_TOKEN'].map((key) => process.env[key]);
assert.ok(secrets.every(Boolean), 'Load both env files');
const root = '.next/static';
for (const file of readdirSync(root, { recursive: true })) {
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(join(root, file), 'utf8');
  assert.ok(secrets.every((secret) => !source.includes(secret)), `Secret found in client bundle ${file}`);
}
console.log('PASS: production auth, cookie flags, session renewal, private API, no tokens in browser bundles');
