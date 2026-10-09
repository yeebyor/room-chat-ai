// HFMA stage 1: database rules only (invariants I1, I2, I3, I5, I6 in HFMA.md).
// Commit hashes are made up; git work belongs to scripts/hfma.mjs (stage 2).
// Run: node --env-file=.env.local --env-file=.env.agents.local scripts/smoke-hfma.mjs
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

const base = process.env.CHAT_BASE_URL || 'http://localhost:3000';
const room = `verify-hfma-${randomUUID().slice(0, 8)}`;
const tokens = { GPT: process.env.CHAT_GPT_TOKEN, Claude: process.env.CHAT_CLAUDE_TOKEN, Gemini: process.env.CHAT_GEMINI_TOKEN, yeebyor: process.env.CHAT_USER_TOKEN };
assert.ok(Object.values(tokens).every(Boolean), 'Load both .env.local and .env.agents.local');

async function hfma(sender, op, args = {}) {
  const response = await fetch(new URL('/api/hfma', base), {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens[sender]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, data: await response.json() };
}
const ok = async (sender, op, args) => {
  const result = await hfma(sender, op, args);
  assert.equal(result.status, 200, `${sender} ${op}: ${JSON.stringify(result.data)}`);
  return result.data;
};
const refused = async (status, pattern, sender, op, args) => {
  const result = await hfma(sender, op, args);
  assert.equal(result.status, status, `${sender} ${op} should be ${status}: ${JSON.stringify(result.data)}`);
  if (pattern) assert.match(result.data.error, pattern);
};
const hash = () => randomBytes(20).toString('hex');
const evidence = async (sender, task, kind, commit, exitCode = 0) => (await ok(sender, 'evidence_add', {
  room, task, kind, commit, command: 'npm test', exit_code: exitCode, timed_out: false, duration_ms: 1200,
  output: exitCode === 0 ? 'ok 3 tests' : 'not ok 1', env: { node: process.version },
})).evidence;
const RESULT = '# Findings\nAll good.\n# Assumptions\nNone.\n# Evidence\nTests pass.\n# Objections\nNone.';

const charter = {
  project_path: 'C:/tmp/verify-project', goal: 'Proyek uji HFMA.', orchestrator: 'Claude', test_command: 'npm test',
  criteria: [
    { id: 'C1', text: 'Tes lulus.', check: 'command', command: 'npm test' },
    { id: 'C2', text: 'Owner paham laporannya.', check: 'owner' },
  ],
  ownership: { Claude: ['a/**'], GPT: ['b/**'], Gemini: ['c/**'] },
};

// Setup and I1: only yeebyor writes the charter; a room needs one before any task.
assert.equal((await fetch(new URL('/api/rooms', base), {
  method: 'POST', headers: { Authorization: `Bearer ${tokens.yeebyor}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ room }),
})).status, 201);
await refused(404, /has no charter/, 'Claude', 'task_create', { room, title: 'Terlalu cepat', team: 'GPT' });
await refused(403, /yeebyor/, 'Claude', 'charter_set', { room, charter });
await refused(422, /orchestrator/, 'yeebyor', 'charter_set', { room, charter: { ...charter, orchestrator: 'Bob' } });
await refused(422, /command/, 'yeebyor', 'charter_set', { room, charter: { ...charter, criteria: [{ id: 'C1', text: 'x', check: 'command' }] } });
assert.equal((await ok('yeebyor', 'charter_set', { room, charter })).version, 1);
assert.equal((await ok('GPT', 'charter_get', { room })).charter.orchestrator, 'Claude');
await refused(422, /Unknown operation/, 'GPT', 'drop_everything', {});

// I2: only the orchestrator or yeebyor creates tasks; claims follow team and dependencies.
await refused(403, /orchestrator/, 'GPT', 'task_create', { room, title: 'Bukan orkestrator', team: 'GPT' });
const a = (await ok('Claude', 'task_create', { room, title: 'Modul b', team: 'GPT' })).id;
const b = (await ok('Claude', 'task_create', { room, title: 'Laporan c', team: 'Gemini', depends_on: [a] })).id;
await refused(422, /depends_on/, 'Claude', 'task_create', { room, title: 'Dependensi palsu', team: 'Gemini', depends_on: [999999999] });
await refused(409, /dependencies/, 'Gemini', 'task_claim', { task: b });
await refused(403, /team GPT/, 'Claude', 'task_claim', { task: a });
let task = await ok('GPT', 'task_claim', { task: a });
assert.equal(task.status, 'CLAIMED');
assert.equal(task.generation, 1);
await refused(409, /not TODO/, 'GPT', 'task_claim', { task: a });
await refused(409, /Stale claim generation/, 'GPT', 'task_heartbeat', { task: a, generation: 0 });
await ok('GPT', 'task_heartbeat', { task: a, generation: 1 });

// Evidence must pass, belong to the submitter and match the commit.
const h1 = hash();
await refused(422, /commit hash/, 'GPT', 'evidence_add', { room, task: a, kind: 'submit', commit: 'abc', command: 'npm test', exit_code: 0, timed_out: false, duration_ms: 1, output: '' });
await refused(422, /exit_code/, 'GPT', 'evidence_add', { room, task: a, kind: 'submit', commit: h1, command: 'npm test', timed_out: false, duration_ms: 1, output: '' });
const failing = await evidence('GPT', a, 'submit', h1, 1);
await refused(409, /passing submit evidence/, 'GPT', 'task_submit', { task: a, generation: 1, commit: h1, evidence: failing });
const passing = await evidence('GPT', a, 'submit', h1);
await refused(409, /passing submit evidence/, 'GPT', 'task_submit', { task: a, generation: 1, commit: hash(), evidence: passing });

// I5: no submit while a sub-agent delegation is open; results keep four sections.
const child = (await ok('GPT', 'delegate', { task: a, generation: 1, label: 'penulis-tes', contract: 'Tulis tes untuk b/.' })).delegation;
await refused(409, /sub-agent delegation/, 'GPT', 'task_submit', { task: a, generation: 1, commit: h1, evidence: passing });
await refused(403, /team GPT/, 'Claude', 'child_close', { delegation: child, status: 'accepted', result: RESULT });
await refused(422, /Assumptions, Evidence, Objections/, 'GPT', 'child_close', { delegation: child, status: 'accepted', result: '# Findings\nAll good.' });
await ok('GPT', 'child_close', { delegation: child, status: 'accepted', result: RESULT });
await refused(409, /already closed/, 'GPT', 'child_close', { delegation: child, status: 'cancelled' });
assert.equal((await ok('GPT', 'task_submit', { task: a, generation: 1, commit: h1, evidence: passing })).status, 'REVIEW');

// I3: approval only from another team, bound to the candidate, with the reviewer's own passing verify run.
await refused(403, /may not review its own task/, 'GPT', 'task_review', { task: a, verdict: 'approve', commit: h1, notes: 'Saya sendiri.' });
await refused(409, /verify evidence/, 'Claude', 'task_review', { task: a, verdict: 'approve', commit: h1, notes: 'Pakai bukti GPT.', evidence: passing });
const verified = await evidence('Claude', a, 'verify', h1);
await refused(409, /candidate under review/, 'Claude', 'task_review', { task: a, verdict: 'approve', commit: hash(), notes: 'Hash lain.', evidence: verified });
await refused(422, /notes/, 'Claude', 'task_review', { task: a, verdict: 'approve', commit: h1, evidence: verified });
assert.equal((await ok('Claude', 'task_review', { task: a, verdict: 'approve', commit: h1, notes: 'Tes b/ mencakup C1.', evidence: verified })).status, 'APPROVED');

// Integration: the holder or orchestrator records the outcome; merged needs its own passing run.
const m1 = hash();
await refused(403, /orchestrator/, 'Gemini', 'task_integrate', { task: a, commit: h1, outcome: 'failed', reason: 'x' });
await refused(409, /approved hash/, 'GPT', 'task_integrate', { task: a, commit: hash(), outcome: 'failed', reason: 'x' });
const merged = await evidence('GPT', a, 'integrate', m1);
await refused(422, /ownership_ok/, 'GPT', 'task_integrate', { task: a, commit: h1, outcome: 'merged', merge_hash: m1, evidence: merged });
task = await ok('GPT', 'task_integrate', { task: a, commit: h1, outcome: 'merged', merge_hash: m1, evidence: merged, ownership_ok: true });
assert.equal(task.status, 'DONE');
assert.equal(task.merge_hash, m1);
assert.equal((await ok('Gemini', 'charter_get', { room })).project.main_hash, m1);

// A main branch that moved outside integrate freezes integration until yeebyor checks it.
assert.equal((await ok('Gemini', 'main_report', { room, main_hash: m1 })).consistent, true);
const stray = hash();
assert.equal((await ok('Gemini', 'main_report', { room, main_hash: stray })).consistent, false);
const c = (await ok('Claude', 'task_create', { room, title: 'Modul c', team: 'Gemini' })).id;
await ok('Gemini', 'task_claim', { task: c });
const h2 = hash();
await ok('Gemini', 'task_submit', { task: c, generation: 1, commit: h2, evidence: await evidence('Gemini', c, 'submit', h2) });
await ok('Claude', 'task_review', { task: c, verdict: 'approve', commit: h2, notes: 'Cukup.', evidence: await evidence('Claude', c, 'verify', h2) });
await refused(409, /outside integrate/, 'Gemini', 'task_integrate', { task: c, commit: h2, outcome: 'moved' });
await refused(403, /yeebyor/, 'Claude', 'main_set', { room, main_hash: stray, reason: 'Saya rapikan.' });
await ok('yeebyor', 'main_set', { room, main_hash: stray, reason: 'Commit manual yeebyor, diperiksa.' });

// A merge built on a main that has moved since (a concurrent integrate) is refused.
const m2 = hash();
const late = await evidence('Gemini', c, 'integrate', m2);
await refused(409, /main moved/, 'Gemini', 'task_integrate', { task: c, commit: h2, outcome: 'merged', merge_hash: m2, base: m1, evidence: late, ownership_ok: true });
assert.equal((await ok('Gemini', 'task_get', { task: c })).status, 'APPROVED', 'The task stays APPROVED for another integrate');

// A branch that moved after approval sends the task back for a fresh submit.
assert.equal((await ok('Gemini', 'task_integrate', { task: c, commit: h2, outcome: 'moved' })).status, 'CLAIMED');

// Three rejections block the task for yeebyor; silence is never approval.
for (let i = 1; i <= 3; i++) {
  const h = hash();
  await ok('Gemini', 'task_submit', { task: c, generation: 1, commit: h, evidence: await evidence('Gemini', c, 'submit', h) });
  task = await ok('GPT', 'task_review', { task: c, verdict: 'reject', commit: h, notes: `Penolakan ${i}.` });
}
assert.equal(task.status, 'BLOCKED');
assert.match(task.block_reason, /Rejected 3 times/);
await refused(403, /yeebyor/, 'Claude', 'task_unblock', { task: c, reason: 'Lanjut.' });
assert.equal((await ok('yeebyor', 'task_unblock', { task: c, reason: 'Arahan baru sudah diberikan.' })).status, 'CLAIMED');

// Reassign bumps the generation, so the previous holder's calls are stale.
await refused(422, /reason/, 'Claude', 'task_reassign', { task: c });
task = await ok('Claude', 'task_reassign', { task: c, reason: 'Gemini kehabisan konteks.', team: 'GPT' });
assert.equal(task.status, 'TODO');
assert.equal(task.generation, 2);
await refused(403, /team GPT/, 'Gemini', 'task_heartbeat', { task: c, generation: 1 });
assert.equal((await ok('GPT', 'task_claim', { task: c })).generation, 3);
await refused(409, /Stale claim generation/, 'GPT', 'delegate', { task: c, generation: 2, label: 'x', contract: 'x' });

// Decisions: one active decision per key; a second one that does not name what it supersedes
// is a conflict, resolved by the orchestrator only when neither side is its own.
const storage = await ok('GPT', 'decision_add', { room, key: ' Storage ', title: 'IndexedDB', body: 'Data lokal disimpan di IndexedDB.' });
assert.equal(storage.status, 'active');
assert.equal(storage.key, 'storage', 'Keys are trimmed and lowercased');
await refused(422, /key must be/, 'GPT', 'decision_add', { room, key: '!!', title: 'x', body: 'x' });
const rival = await ok('Gemini', 'decision_add', { room, key: 'storage', title: 'localStorage', body: 'Cukup localStorage.' });
assert.equal(rival.status, 'conflict');
assert.equal(rival.conflicts_with, storage.id);
const styling = await ok('GPT', 'decision_add', { room, key: 'styling', title: 'Tailwind', body: 'Pakai Tailwind.' });
await refused(409, /supersedes must name/, 'GPT', 'decision_add', { room, key: 'styling', title: 'CSS', body: 'x', supersedes: storage.id });
const plainCss = await ok('Claude', 'decision_add', { room, key: 'styling', title: 'Plain CSS', body: 'Tanpa framework.', supersedes: styling.id });
assert.equal(plainCss.status, 'active', 'A deliberate change is not a conflict');
await refused(403, /Only yeebyor/, 'GPT', 'decision_resolve', { decision: rival.id, choice: 'replace', reason: 'Saya pihak.' });
await refused(422, /reason/, 'Claude', 'decision_resolve', { decision: rival.id, choice: 'replace' });
await refused(422, /choice/, 'Claude', 'decision_resolve', { decision: rival.id, choice: 'maybe', reason: 'x' });

// Only yeebyor closes, and only with every task finished and every criterion proven.
await refused(403, /yeebyor/, 'Claude', 'project_close', { room, owner_criteria: ['C2'] });
await refused(409, /not DONE/, 'yeebyor', 'project_close', { room, owner_criteria: ['C2'] });
await ok('Claude', 'task_cancel', { task: c, reason: 'Diganti tugas lain.' });
await ok('Claude', 'task_cancel', { task: b, reason: 'Tidak dibutuhkan lagi.' });
await refused(409, /decision conflict/, 'yeebyor', 'project_close', { room, owner_criteria: ['C2'] });
const resolved = await ok('Claude', 'decision_resolve', { decision: rival.id, choice: 'replace', reason: 'Data kecil; localStorage cukup.' });
assert.equal(resolved.status, 'active');
assert.equal(resolved.supersedes, storage.id);
await refused(409, /not a conflict/, 'yeebyor', 'decision_resolve', { decision: rival.id, choice: 'keep', reason: 'x' });
await refused(409, /C1/, 'yeebyor', 'project_close', { room, owner_criteria: ['C2'] });
await refused(403, /yeebyor/, 'Claude', 'evidence_add', { room, kind: 'close', criterion: 'C1', commit: stray, command: 'npm test', exit_code: 0, timed_out: false, duration_ms: 1, output: 'ok' });
await ok('yeebyor', 'evidence_add', { room, kind: 'close', criterion: 'C1', commit: stray, command: 'npm test', exit_code: 0, timed_out: false, duration_ms: 1, output: 'ok' });
await refused(409, /C2/, 'yeebyor', 'project_close', { room });
assert.equal((await ok('yeebyor', 'project_close', { room, owner_criteria: ['C2'] })).closed, true);
await refused(409, /closed this project/, 'Claude', 'task_create', { room, title: 'Setelah tutup', team: 'GPT' });
await refused(409, /closed this project/, 'yeebyor', 'charter_set', { room, charter });

// I6: every state change of task a left an event, in order.
const detail = await ok('Gemini', 'task_get', { task: a });
assert.deepEqual(detail.events.map((event) => event.op), ['create', 'claim', 'evidence_submit', 'evidence_submit', 'delegate',
  'child_accepted', 'submit', 'evidence_verify', 'approve', 'evidence_integrate', 'integrate']);
assert.equal(detail.reviews.length, 1);
assert.equal(detail.delegations[0].status, 'accepted');
const board = await ok('Gemini', 'board', { room });
assert.deepEqual(board.tasks.map((item) => item.status), ['DONE', 'CANCELLED', 'CANCELLED']);
assert.ok(board.project.closed_at);
assert.deepEqual(board.decisions.map((item) => `${item.key}:${item.title}:${item.status}`),
  ['storage:IndexedDB:superseded', 'storage:localStorage:active', 'styling:Tailwind:superseded', 'styling:Plain CSS:active']);

// Direct REST access with the publishable key must not reach HFMA tables.
const direct = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tasks?select=*`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY } });
assert.ok(!direct.ok, 'HFMA tables are not exposed');
console.log(JSON.stringify({ status: 'PASS', room, checks: 'I1 charter and close owner-only, decisions and conflicts, I2 transitions/roles/generations, I3 review gate, I5 open delegations, I6 events, main consistency, escalation, private tables' }));
