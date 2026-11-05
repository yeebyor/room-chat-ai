// Local git and test running for HFMA, shared by scripts/hfma.mjs and the owner's
// routes (src/app/api/hfma/local). Plain JavaScript with Node built-ins only, so
// both the CLI and the Next.js server can import it. Never sends anything anywhere.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENTS = ['Claude', 'GPT', 'Gemini'];
export const TEST_TIMEOUT_MS = 10 * 60 * 1000;

export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr.trim()}`);
  return result.stdout.trim();
}
export const tryGit = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;
// Tracked files changed or staged in the project folder, which only integrate may touch.
// Untracked files (caches from running the tests there) do not count.
// Read untrimmed: each porcelain line starts with a two-letter status that may begin with a space.
export function dirtyFiles(project) {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: project, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git status failed in ${project}:\n${result.stderr.trim()}`);
  return result.stdout.split('\n').filter((line) => line.trim()).map((line) => line.slice(3).trim());
}
// Merge and setup commits carry the acting agent (or yeebyor), never anyone's personal
// email, in the same form as each team worktree's own identity (see setupRepo).
export const identity = (who) => ['-c', `user.name=${who} (HFMA)`, '-c', `user.email=${who.toLowerCase()}@hfma.localhost`];

export const worktrees = (project) => `${project}.wt`;
export const teamTree = (project, team) => join(worktrees(project), team);

// One scratch checkout per caller, so two agents can verify at the same time. -x also removes
// ignored files: a build output or node_modules left by an earlier run could make a test pass
// on a commit that does not have them. So every run has to install what it needs.
export function scratch(project, commit, who) {
  const path = join(worktrees(project), `_verify-${who}`);
  if (!existsSync(path)) git(project, 'worktree', 'add', '--detach', path, commit);
  git(path, 'checkout', '--detach', '--force', commit);
  git(path, 'clean', '-fdx');
  return path;
}

// One test run at a time per caller: a second run in the same scratch checkout would clean it under
// the first. The lock names the process and when it must be done, so a crashed run does not block
// the next one. Two closes from the board are refused the same way.
export async function withScratch(project, commit, who, work) {
  mkdirSync(worktrees(project), { recursive: true });
  const lock = `${join(worktrees(project), `_verify-${who}`)}.lock`;
  const mine = JSON.stringify({ pid: process.pid, until: Date.now() + TEST_TIMEOUT_MS + 120000, at: Math.random() });
  const take = () => { try { writeFileSync(lock, mine, { flag: 'wx' }); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } };
  if (!take()) {
    let held = null;
    try { held = JSON.parse(readFileSync(lock, 'utf8')); } catch { /* unreadable: treat as stale */ }
    const alive = held && Date.now() < held.until && (() => { try { process.kill(held.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } })();
    if (alive) throw Object.assign(new Error(`A test run by ${who} is already running in this project. Wait for it to finish.`), { code: 'SCRATCH_BUSY' });
    rmSync(lock, { force: true });
    if (!take()) throw Object.assign(new Error(`A test run by ${who} has just started in this project. Wait for it to finish.`), { code: 'SCRATCH_BUSY' });
  }
  try {
    return await work(scratch(project, commit, who));
  } finally {
    try { if (readFileSync(lock, 'utf8') === mine) rmSync(lock, { force: true }); } catch { /* a lock left behind expires by itself */ }
  }
}

// main is behind the hash HFMA recorded only when a merge was recorded and the folder has not moved
// yet: integrate is doing it this moment, or died in between. Either way the merge is approved and
// tested, so finish the move rather than freeze the project. Anything else stays a real mismatch.
export function catchUpMain(project, recorded) {
  const main = git(project, 'rev-parse', 'main');
  if (!recorded || main === recorded || !tryGit(project, 'merge-base', '--is-ancestor', main, recorded)) return main;
  tryGit(project, 'merge', '--ff-only', recorded);
  return git(project, 'rev-parse', 'main');
}

// Existing test files a commit changes or deletes, compared with main. Adding tests is what a task
// should do; changing the ones that judge it deserves a second look, because a passing run proves
// nothing about a test that was weakened. check.mjs counts, since it decides what "passing" means.
const TEST_FILE = /(^|\/)(check\.mjs|conftest\.py|pytest\.ini|test[^/]*|[^/]*[._-]test[^/]*|[^/]*\.spec\.[^/]+)$|(^|\/)(tests?|__tests__|spec)\//i;
export function changedTests(project, commit) {
  return git(project, 'diff', '--name-status', '--no-renames', `main...${commit}`).split('\n').filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([status, file]) => (status === 'M' || status === 'D') && TEST_FILE.test(file))
    .map(([, file]) => file);
}

// Test code is written by the agents, so it never sees the tokens of whoever runs it: at close that
// is the owner's, in the server's environment, and a test that prints its environment would put them
// in the recorded output.
function testEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CHAT_.*_TOKEN|SUPABASE_.*)$/i.test(name)));
}

// Runs a shell command with a time limit and keeps the last 200 lines.
export function run(cwd, cmd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: testEnvironment() });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill('SIGKILL');
    }, TEST_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = output.split(/\r?\n/).slice(-200).join('\n').slice(-16000);
      resolve({ exit_code: timedOut ? null : code, timed_out: timedOut, duration_ms: Date.now() - started, output: tail });
    });
  });
}
export const environment = () => ({ node: process.version, git: git('.', '--version'), platform: process.platform });

// Browsers load SVG through <img> as strict XML: one HTML-only entity such as
// &bull; makes the whole image fail while every unit test still passes.
const XML_ENTITY = /&(?!(?:amp|lt|gt|quot|apos);|#[0-9]+;|#x[0-9a-fA-F]+;)[A-Za-z][A-Za-z0-9]*;/;
export function svgProblems(cwd) {
  return git(cwd, 'ls-files', '*.svg').split('\n').filter(Boolean).flatMap((file) => {
    const content = readFileSync(join(cwd, file), 'utf8');
    const entity = XML_ENTITY.exec(content)?.[0];
    if (entity) return [`${file}: entity ${entity} is not valid in XML (use &#...; or the character itself)`];
    return /<svg[\s>]/.test(content) ? [] : [`${file}: contains no <svg> element`];
  });
}

// The command's result, failed as well when an SVG in the checkout is invalid.
export async function checkedRun(cwd, cmd) {
  const result = await run(cwd, cmd);
  const problems = svgProblems(cwd);
  if (problems.length) {
    result.output = `HFMA ASSET CHECK FAILED:\n${problems.join('\n')}\n\n${result.output}`.slice(0, 16000);
    if (result.exit_code === 0) result.exit_code = 1;
  }
  return result;
}

// Subject, author, time, and changed files of one commit, for the owner's export.
// Merge commits list what they brought into main (the diff against the first
// parent). Null when the hash is not in the repo, for example after a reset.
export function commitInfo(project, hash) {
  if (!tryGit(project, 'cat-file', '-e', `${hash}^{commit}`)) return null;
  const [subject, author, date, parents] = git(project, 'show', '-s', '--format=%s%x00%an%x00%aI%x00%P', hash).split('\0');
  const parent = parents.split(' ').filter(Boolean)[0];
  const diff = parent
    ? git(project, 'diff', '--name-status', parent, hash)
    : git(project, 'show', '--name-status', '--format=', hash);
  const files = diff.split('\n').filter(Boolean).map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status: status[0], path: paths.at(-1) };
  });
  return { hash, subject, author, date, merge: parents.split(' ').filter(Boolean).length > 1, files };
}

// A repo HFMA created itself: its first commit on main is "HFMA setup". Any
// other existing repo (for example another project in WORK) is never touched.
export function isHfmaRepo(project) {
  if (!existsSync(join(project, '.git')) || !tryGit(project, 'rev-parse', '--verify', 'main')) return false;
  const root = git(project, 'rev-list', '--max-parents=0', 'main').split('\n')[0];
  return git(project, 'log', '-1', '--format=%s', root) === 'HFMA setup';
}
export const isEmptyFolder = (path) => existsSync(path) && readdirSync(path).length === 0;

// Makes the project its own repo with main, then one worktree per team. Safe to
// run again: existing branches and worktrees are kept. Returns main's hash.
export function setupRepo(project, who, teams = AGENTS) {
  if (!existsSync(join(project, '.git'))) {
    git(project, 'init', '-b', 'main');
    git(project, 'add', '-A');
    git(project, ...identity(who), 'commit', '--allow-empty', '-m', 'HFMA setup');
  }
  if (!tryGit(project, 'rev-parse', '--verify', 'main')) throw new Error('The project repo must have a main branch with at least one commit.');
  // Worktree-only settings need this extension (and repository format 1 to honour it).
  git(project, 'config', 'core.repositoryformatversion', '1');
  git(project, 'config', 'extensions.worktreeConfig', 'true');
  for (const team of teams) {
    const path = teamTree(project, team);
    if (!existsSync(path)) {
      if (tryGit(project, 'rev-parse', '--verify', `team/${team}`)) git(project, 'worktree', 'add', path, `team/${team}`);
      else git(project, 'worktree', 'add', '-b', `team/${team}`, path, 'main');
    }
    // Each team commits under its own name, so git history alone shows who wrote what.
    // Set per worktree: the project folder itself keeps the owner's own identity.
    git(path, 'config', '--worktree', 'user.name', `${team} (HFMA)`);
    git(path, 'config', '--worktree', 'user.email', `${team.toLowerCase()}@hfma.localhost`);
  }
  return git(project, 'rev-parse', 'main');
}
