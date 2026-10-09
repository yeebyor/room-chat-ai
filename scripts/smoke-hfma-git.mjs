// HFMA stage 2: scripts/hfma.mjs against a throwaway git repo (invariant I4 in HFMA.md).
// Run: node --env-file=.env.local --env-file=.env.agents.local scripts/smoke-hfma-git.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.CHAT_BASE_URL || 'http://localhost:3000';
const room = `verify-git-${randomUUID().slice(0, 8)}`;
// Owner setup only works inside WORK (the folder that holds room-chat-ai), so the throwaway
// repo lives there in a hidden folder that is removed at the end.
const WORK = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const work = mkdtempSync(join(WORK, '.hfma-verify-'));
const project = join(work, 'proj').replaceAll('\\', '/');
const cliPath = fileURLToPath(new URL('./hfma.mjs', import.meta.url));

function cli(name, ...args) {
  const result = spawnSync(process.execPath, [cliPath, name, ...args], { encoding: 'utf8', env: process.env });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* not every command prints JSON on failure */ }
  return { status: result.status, out: result.stdout, err: result.stderr, json };
}
const ok = (name, ...args) => {
  const result = cli(name, ...args);
  assert.equal(result.status, 0, `${name} ${args.join(' ')}:\n${result.err}`);
  return result.json;
};
const fails = (pattern, name, ...args) => {
  const result = cli(name, ...args);
  assert.notEqual(result.status, 0, `${name} ${args.join(' ')} should fail`);
  if (pattern) assert.match(result.err + result.out, pattern);
  return result;
};
const file = (name, content) => { const path = join(work, name); writeFileSync(path, content); return path; };
const tree = (team) => `${project}.wt/${team}`;
function commit(cwd, path, content) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
  for (const args of [['add', '-A'], ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-m', `edit ${path}`]]) {
    assert.equal(spawnSync('git', args, { cwd }).status, 0);
  }
}
const head = (cwd, ref = 'HEAD') => spawnSync('git', ['rev-parse', ref], { cwd, encoding: 'utf8' }).stdout.trim();
const task = (id) => ok('Gemini', 'task', id);
const notes = file('notes.md', 'Diperiksa: tes menutup kriteria C1.');

const TEST = `import { existsSync, readFileSync } from 'node:fs';
const read = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const a = read('a/x.txt'), b = read('b/y.txt'), c = read('c/z.txt');
if ([a, b, c].some((value) => value.includes('BUG'))) { console.error('BUG found'); process.exit(1); }
if (read('a/w.txt') === 'conflict-a' && read('b/v.txt') === 'conflict-b') { console.error('a and b disagree'); process.exit(1); }
console.log('ok');
`;
const createRoom = async (name) => assert.equal((await fetch(new URL('/api/rooms', base), {
  method: 'POST', headers: { Authorization: `Bearer ${process.env.CHAT_USER_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ room: name }),
})).status, 201);
const charterFile = (path, extra = {}) => file('charter.json', JSON.stringify({
  project_path: path, goal: 'Uji HFMA tahap 2.', orchestrator: 'Claude', test_command: 'node test.mjs',
  criteria: [{ id: 'C1', text: 'Tes lulus di main.', check: 'command', command: 'node test.mjs' }, { id: 'C2', text: 'Owner paham.', check: 'owner' }],
  ownership: { Claude: ['a/**'], GPT: ['b/**'], Gemini: ['c/**'] }, ...extra,
}));

// Setup refuses folders outside WORK and folders that already hold someone's files.
const guarded = `${room}-guard`;
await createRoom(guarded);
ok('yeebyor', 'charter', guarded, '--file', charterFile(resolve(WORK, '..', 'outside-work').replaceAll('\\', '/')));
fails(/inside the WORK folder/, 'yeebyor', 'setup', guarded);
mkdirSync(join(work, 'occupied'));
writeFileSync(join(work, 'occupied', 'keep.txt'), 'data milik orang lain');
ok('yeebyor', 'charter', guarded, '--file', charterFile(join(work, 'occupied').replaceAll('\\', '/')));
fails(/already contains files/, 'yeebyor', 'setup', guarded);
assert.ok(!existsSync(join(work, 'occupied', '.git')), 'An occupied folder is left untouched');

await createRoom(room);
const charter = charterFile(project);
fails(/yeebyor/, 'Claude', 'charter', room, '--file', charter);
ok('yeebyor', 'charter', room, '--file', charter);
fails(/yeebyor/, 'GPT', 'setup', room);
const setup = ok('yeebyor', 'setup', room);
assert.ok(['Claude', 'GPT', 'Gemini'].every((team) => existsSync(tree(team))), 'One worktree per team');
assert.equal(setup.main_hash, head(project, 'main'));
assert.equal(ok('yeebyor', 'setup', room).main_hash, setup.main_hash, 'Setup again is harmless');

// A plain commit in a team worktree carries that team's name; the project folder keeps the owner's.
const plain = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
writeFileSync(join(tree('Claude'), 'who.txt'), 'x');
plain(tree('Claude'), 'add', 'who.txt');
assert.equal(plain(tree('Claude'), 'commit', '-qm', 'identity check').status, 0);
assert.equal(plain(tree('Claude'), 'log', '-1', '--format=%an <%ae>').stdout.trim(), 'Claude (HFMA) <claude@hfma.localhost>');
assert.notEqual(plain(project, 'config', 'user.name').stdout.trim(), 'Claude (HFMA)', 'The project folder keeps the owner identity');
plain(tree('Claude'), 'reset', '-q', '--hard', 'HEAD~1');

// The owner adds the test straight to main, accepts that main, and teams pick it up.
commit(project, 'test.mjs', TEST);
ok('yeebyor', 'main-set', room, '--reason', 'Owner menambah test.mjs di main.');
for (const team of ['Claude', 'GPT', 'Gemini']) assert.equal(spawnSync('git', ['merge', '--ff-only', 'main'], { cwd: tree(team) }).status, 0);

// next tells each agent what to do. Before any task exists only the orchestrator (Claude) has work,
// and nobody else is idle yet.
const next = (name) => cli(name, 'next', room, '--timeout', '0').json;
assert.equal(next('Claude').action, 'plan');
assert.equal(next('GPT').action, 'waiting', 'Nobody is idle before tasks exist');

// Full path to DONE: dirty tree refused, failing tests refused, approval needs the reviewer's own run.
const a = ok('Claude', 'create', room, '--title', 'Isi b', '--team', 'GPT').id;
assert.equal(next('GPT').action, 'claim');
assert.equal(next('Gemini').action, 'waiting', 'No task for Gemini, but it may be needed as a reviewer: not idle');
ok('GPT', 'claim', String(a));
assert.equal(next('GPT').action, 'work');
writeFileSync(join(tree('GPT'), 'b-draft.txt'), 'belum commit');
fails(/uncommitted changes/, 'GPT', 'submit', String(a));
rmSync(join(tree('GPT'), 'b-draft.txt'));
commit(tree('GPT'), 'b/y.txt', 'BUG');
fails(/FAILED/, 'GPT', 'submit', String(a));
assert.equal(task(a).status, 'CLAIMED');
commit(tree('GPT'), 'b/y.txt', 'ok');
assert.equal(ok('GPT', 'submit', String(a)).status, 'REVIEW');
assert.equal(next('Gemini').action, 'review');
assert.equal(cli('Claude', 'wait', String(a), '--until', 'DONE', '--timeout', '0').status, 2, 'wait keeps waiting before DONE');
fails(/verify first/, 'Claude', 'review', String(a), 'approve', '--file', notes);
fails(/may not review its own task/, 'GPT', 'review', String(a), 'reject', '--file', notes);
assert.equal(ok('Claude', 'verify', String(a)).passed, true);
assert.equal(ok('Claude', 'review', String(a), 'approve', '--file', notes).status, 'APPROVED');
assert.equal(next('GPT').action, 'integrate');
let done = ok('GPT', 'integrate', String(a));
assert.equal(ok('Claude', 'wait', String(a), '--until', 'DONE').result, 'reached');
assert.equal(done.status, 'DONE');
assert.equal(head(project, 'main'), done.merge_hash, 'main moved to the recorded merge');
assert.equal(plain(project, 'log', '-1', '--format=%an <%ae>', 'main').stdout.trim(), 'GPT (HFMA) <gpt@hfma.localhost>', 'The merge names the team that integrated');
assert.equal(readFileSync(join(project, 'b/y.txt'), 'utf8'), 'ok', 'The project folder follows main');

// A branch that moved after approval goes back for a fresh submit.
const b = ok('Claude', 'create', room, '--title', 'Isi c', '--team', 'Gemini').id;
ok('Gemini', 'claim', String(b));
// An SVG with an HTML-only entity fails the run even though the project's tests pass.
commit(tree('Gemini'), 'c/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>Zello &bull; Tee</text></svg>');
fails(/entity &bull; is not valid/, 'Gemini', 'submit', String(b));
commit(tree('Gemini'), 'c/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>Zello &#8226; Tee</text></svg>');
commit(tree('Gemini'), 'c/z.txt', 'satu');
ok('Gemini', 'submit', String(b));
// A second reviewer's finding goes in a note; next hands it to the holder, then to the
// reviewer of the resubmission.
ok('GPT', 'note', String(b), '--file', file('note.md', 'Second finding: the folder argument crashes.'));
ok('Claude', 'verify', String(b));
ok('Claude', 'review', String(b), 'approve', '--file', notes);
commit(tree('Gemini'), 'c/z.txt', 'dua');
assert.equal(fails(null, 'Gemini', 'integrate', String(b)).json.status, 'CLAIMED');
const holder = next('Gemini');
assert.equal(holder.action, 'work');
assert.deepEqual(holder.feedback?.map((item) => [item.from, item.kind]), [['GPT', 'note']], 'The holder sees the note');
ok('Gemini', 'submit', String(b));
const again = next('GPT');
assert.equal(again.action, 'review');
assert.match(again.previous_feedback?.[0]?.text ?? '', /Second finding/, 'The next reviewer sees the earlier note');
ok('GPT', 'verify', String(b));
ok('GPT', 'review', String(b), 'approve', '--file', notes);
assert.equal(ok('Gemini', 'integrate', String(b)).status, 'DONE');

// Files outside the team's paths wait for yeebyor's exception.
const c = ok('Claude', 'create', room, '--title', 'Sentuh a', '--team', 'Gemini').id;
ok('Gemini', 'claim', String(c));
commit(tree('Gemini'), 'a/x.txt', 'dari Gemini');
ok('Gemini', 'submit', String(c));
ok('GPT', 'verify', String(c));
ok('GPT', 'review', String(c), 'approve', '--file', notes);
const blocked = fails(null, 'Gemini', 'integrate', String(c)).json;
assert.equal(blocked.status, 'BLOCKED');
assert.match(blocked.block_reason, /a\/x\.txt/);
fails(/yeebyor/, 'Claude', 'exception', String(c), '--reason', 'Boleh.');
assert.equal(ok('yeebyor', 'exception', String(c), '--reason', 'Perbaikan kecil lintas modul, disetujui.').status, 'APPROVED');
assert.equal(ok('Gemini', 'integrate', String(c)).status, 'DONE');

// A merge conflict with main sends the task back (Gemini already wrote a/x.txt on main).
const d = ok('Claude', 'create', room, '--title', 'Isi a', '--team', 'Claude').id;
ok('Claude', 'claim', String(d));
commit(tree('Claude'), 'a/x.txt', 'dari Claude');
ok('Claude', 'submit', String(d));
ok('GPT', 'verify', String(d));
ok('GPT', 'review', String(d), 'approve', '--file', notes);
assert.equal(fails(/Merge conflict/, 'Claude', 'integrate', String(d)).json.status, 'CLAIMED');

// Each change passes alone, but main plus both fails: integrate tests the merged result.
// A second failed integration in a row blocks the task for yeebyor.
assert.equal(spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'merge', '-X', 'theirs', '--no-edit', 'main'], { cwd: tree('Claude') }).status, 0);
commit(tree('Claude'), 'a/w.txt', 'conflict-a');
ok('Claude', 'submit', String(d));
ok('GPT', 'verify', String(d));
ok('GPT', 'review', String(d), 'approve', '--file', notes);
const e = ok('Claude', 'create', room, '--title', 'Isi b/v', '--team', 'GPT').id;
ok('GPT', 'claim', String(e));
commit(tree('GPT'), 'b/v.txt', 'conflict-b');
ok('GPT', 'submit', String(e));
ok('Gemini', 'verify', String(e));
ok('Gemini', 'review', String(e), 'approve', '--file', notes);
assert.equal(ok('GPT', 'integrate', String(e)).status, 'DONE');
const failed = fails(/Tests failed on the result merged/, 'Claude', 'integrate', String(d)).json;
assert.equal(failed.status, 'BLOCKED');
assert.match(failed.block_reason, /2 times/);
ok('Claude', 'cancel', String(d), '--reason', 'Desain a dan b bertentangan, dibatalkan.');
// Every task finished: others keep waiting until close (the orchestrator may still add
// follow-ups), and a call from yeebyor in the room reaches them as owner_message.
const rest = next('Gemini');
assert.equal(rest.action, 'waiting');
assert.match(rest.why, /stop only at closed/);
// One retry: the CLI calls above block this process for minutes, so the kept-alive socket
// from the last fetch may already be closed by the server (ECONNRESET).
const say = async (who, token, message, lastSeen) => {
  const body = JSON.stringify({ room, message, client_id: randomUUID(), ...(lastSeen ? { last_seen_id: lastSeen } : {}) });
  const post = () => fetch(new URL('/api/messages', base), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body,
  });
  return (await post().catch(post)).json();
};
const called = await say('yeebyor', process.env.CHAT_USER_TOKEN, '@Gemini what is left on your side?');
const answer = next('Gemini');
assert.equal(answer.action, 'owner_message');
assert.match(answer.text, /what is left/);
assert.equal(next('GPT').action, 'waiting', 'Only the agent mentioned is called');
await say('Gemini', process.env.CHAT_GEMINI_TOKEN, 'Nothing is left on my side.', called.message.id);
assert.equal(next('Gemini').action, 'waiting', 'Answered: back to work');
assert.equal(next('Claude').action, 'all_done', 'The orchestrator calls yeebyor instead of going idle');

// Decisions through the CLI: an open conflict holds back all_done, and the orchestrator
// (Claude, not a party here) is told to resolve it.
const why = file('decision.md', 'Alasan keputusan.');
ok('GPT', 'decide', room, '--key', 'storage', '--title', 'IndexedDB', '--file', why);
const rival = ok('Gemini', 'decide', room, '--key', 'Storage', '--title', 'localStorage', '--file', why);
assert.equal(rival.status, 'conflict');
const settle = next('Claude');
assert.equal(settle.action, 'resolve');
assert.equal(settle.decision, rival.id);
fails(/Only yeebyor/, 'Gemini', 'resolve', String(rival.id), 'replace', '--reason', 'Punya saya.');
ok('Claude', 'resolve', String(rival.id), 'keep', '--reason', 'IndexedDB lebih tahan untuk data besar.');
assert.equal(ok('Gemini', 'decisions', room).find((item) => item.id === rival.id).status, 'rejected');
assert.equal(next('Claude').action, 'all_done', 'Resolved: the project can close again');

// main changed outside integrate: the next command notices and freezes integration.
commit(project, 'README.md', 'manual');
fails(/does not match the HFMA hash/, 'GPT', 'submit', String(e));
assert.equal(ok('Gemini', 'charter', room).project.inconsistent, true);
ok('yeebyor', 'main-set', room, '--reason', 'README manual dari yeebyor, sudah diperiksa.');
assert.equal(ok('Gemini', 'charter', room).project.inconsistent, false);
// Late findings on a DONE task reach the orchestrator (Claude) as a follow-up before
// all_done; a review that arrives after the task left REVIEW is kept as a note.
fails(/CANCELLED/, 'GPT', 'note', String(d), '--file', notes);
ok('GPT', 'note', String(a), '--file', file('late.md', 'Found after DONE: b/y.txt has no newline.'));
const follow = next('Claude');
assert.equal(follow.action, 'follow_up');
assert.equal(follow.task, a);
assert.match(follow.notes[0].text, /no newline/);
assert.equal(ok('Gemini', 'review', String(a), 'approve', '--file', notes).filed_as, 'note', 'A late review becomes a note');
ok('Claude', 'note', String(a), '--file', file('answer.md', 'Both are cosmetic; no follow-up task needed.'));
assert.equal(next('Claude').action, 'all_done', 'Answered follow-ups no longer hold all_done');

// A tracked file changed in the project folder itself also freezes integration, and main
// cannot be accepted until the folder is clean. Untracked files (test caches) do not count.
writeFileSync(join(project, 'cache.tmp'), 'untracked');
fails(/not REVIEW/, 'Claude', 'verify', String(e)); // past the folder check: untracked files are fine
writeFileSync(join(project, 'README.md'), 'edited by hand');
fails(/project folder .* has uncommitted changes: README.md/, 'GPT', 'submit', String(e));
assert.equal(ok('Gemini', 'charter', room).project.inconsistent, true);
fails(/uncommitted changes: README.md/, 'yeebyor', 'main-set', room, '--reason', 'x');
assert.equal(plain(project, 'checkout', '--', 'README.md').status, 0);
ok('yeebyor', 'main-set', room, '--reason', 'Undid a stray edit in the project folder.');
assert.equal(ok('Gemini', 'charter', room).project.inconsistent, false);

// yeebyor hands the orchestrator role over; the charter gets a new version.
fails(/yeebyor/, 'Claude', 'orchestrator', room, 'GPT');
assert.equal(ok('yeebyor', 'orchestrator', room, 'GPT').version, 2);
assert.equal(ok('Gemini', 'charter', room).charter.orchestrator, 'GPT');
fails(/orchestrator/, 'Claude', 'create', room, '--title', 'Bukan lagi orkestrator', '--team', 'GPT');

// Closing runs the command criteria on main itself, against the latest charter.
fails(/Confirm C2 first/, 'yeebyor', 'close', room);
const closed = ok('yeebyor', 'close', room, '--owner', 'C2');
assert.equal(closed.closed, true);
assert.equal(closed.main_hash, head(project, 'main'));

rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ status: 'PASS', room, checks: 'setup, next and wait, invalid SVG, orchestrator handover, dirty tree, failing submit, own verify, integrate to main, moved branch, ownership exception, merge conflict, failing merged tests, escalation counters, main drift detection, review notes and feedback, late reviews and follow-ups, owner calls during work, no early idle, dirty project folder, close with command criteria' }));
