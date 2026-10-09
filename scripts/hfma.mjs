// HFMA command line (see HFMA.md). Runs git and the charter's tests itself and
// sends the raw results to the database, so evidence is never typed by an agent.
// Run with --env-file=<your credentials file>. Never print or pass tokens as arguments.
import { readFileSync } from 'node:fs';
import { checkedRun, dirtyFiles, environment, git, identity, scratch as scratchFor, teamTree, tryGit } from '../src/lib/hfma-local.mjs';

const USAGE = `Usage: hfma.mjs <Name> <command> <target> [options]
  Read:      charter <room> | board <room> | task <id>
  Waiting:   next <room> [--timeout 90] | wait <id> --until DONE[,CANCELLED] [--timeout 90]
  Owner:     charter <room> --file charter.json | setup <room> | main-set <room> --reason text
             orchestrator <room> <Name> | block|unblock|exception <id> --reason text | close <room> [--owner C2,C3]
  Manager:   create <room> --title text --team Name [--file desc.md] [--depends 1,2]
             cancel <id> --reason text | reassign <id> --reason text [--team Name]
  Team:      claim <id> | heartbeat <id> | submit <id> | integrate <id>
             delegate <id> --label name --file contract.md | child <delegation> --status s [--file result.md]
  Reviewer:  verify <id> | review <id> approve|reject --file notes.md | note <id> --file note.md
  Decisions: decisions <room> | decide <room> --key topic --title text --file body.md [--supersedes id]
             resolve <id> keep|replace --reason text`;
const [me, command, target, ...rest] = process.argv.slice(2);
if (!['yeebyor', 'Claude', 'GPT', 'Gemini'].includes(me) || !command || !target) throw new Error(USAGE);
const flags = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else words.push(rest[i]);
}
const token = process.env[me === 'yeebyor' ? 'CHAT_USER_TOKEN' : `CHAT_${me.toUpperCase()}_TOKEN`];
if (!token) throw new Error(`Missing credentials for ${me}. Load your own file: --env-file=${me === 'yeebyor' ? '.env.local' : `.env.agent-${me.toLowerCase()}.local`}`);
const base = process.env.CHAT_BASE_URL || 'http://localhost:3000';

async function api(op, args) {
  const response = await fetch(new URL('/api/hfma', base), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
const print = (value) => console.log(JSON.stringify(value, null, 2));
const text = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '');
const need = (name) => { if (!flags[name]) throw new Error(`Pass --${name}.\n${USAGE}`); return flags[name]; };

// Merge commits carry the acting agent, never anyone's personal email.
const as = identity(me);
const scratch = (project, commit) => scratchFor(project, commit, me);

async function evidence(room, task, kind, commit, cwd, cmd, criterion) {
  // checkedRun also fails the run when an SVG in the checkout is invalid XML.
  const result = await checkedRun(cwd, cmd);
  const saved = await api('evidence_add', { room, task, kind, criterion, commit, command: cmd, ...result, env: environment() });
  console.error(`${kind} ${commit.slice(0, 10)}: ${saved.passed ? 'PASSED' : 'FAILED'} (exit ${result.exit_code}${result.timed_out ? ', timeout' : ''}, ${result.duration_ms} ms)`);
  if (!saved.passed) console.error(result.output);
  return saved;
}

// Owner actions that run git on this machine go through the server, so the CLI and
// the room's buttons share one implementation (src/app/api/hfma/local/route.ts).
async function local(action, args) {
  const response = await fetch(new URL('/api/hfma/local', base), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(60 * 60 * 1000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// Compares main with the last hash HFMA recorded, and checks that nobody changed the
// project folder itself; either freezes integrate until yeebyor checks it.
async function checkMain(room) {
  const charter = await api('charter_get', { room });
  const project = charter.charter.project_path;
  if (!charter.project.main_hash) return charter;
  const dirty = dirtyFiles(project);
  const report = await api('main_report', { room, main_hash: git(project, 'rev-parse', 'main'),
    ...(dirty.length ? { dirty: dirty.join(', ').slice(0, 2000) } : {}) });
  if (dirty.length) throw new Error(`The project folder ${project} has uncommitted changes: ${dirty.join(', ')}. Only integrate may change it; work in your team worktree. Integration is frozen until yeebyor checks it.`);
  if (!report.consistent) throw new Error(`main in ${project} does not match the HFMA hash ${report.main_hash}. Integration is frozen until yeebyor checks it (hfma.mjs main-set).`);
  return charter;
}

// Review findings for the current round: rejects of the last submitted commit and notes
// added since that submit. "previous" gives the round before it, so a reviewer of a
// resubmission can check those findings were addressed.
async function feedback(id, previous = false) {
  const task = await api('task_get', { task: id });
  const submits = task.events.filter((event) => event.op === 'submit');
  const from = submits.at(previous ? -2 : -1);
  const to = previous ? submits.at(-1) : undefined;
  if (previous && !from) return [];
  const rejects = from ? task.reviews.filter((review) => review.verdict === 'reject' && review.commit === from.commit)
    .map((review) => ({ from: review.reviewer, kind: 'reject', text: review.notes })) : [];
  const notes = task.events.filter((event) => event.op === 'note' && (!from || event.id > from.id) && (!to || event.id < to.id))
    .map((event) => ({ from: event.actor, kind: 'note', text: event.reason }));
  return [...rejects, ...notes];
}

// The latest room message from yeebyor that @mentions this agent, if the agent has not
// written in the room since. Agents doing project work only run next, so this is how a
// call from yeebyor reaches them.
async function ownerCall(room) {
  const url = new URL('/api/messages', base);
  url.searchParams.set('room', room);
  url.searchParams.set('limit', '50');
  // A room that cannot be read right now must not stop the work loop.
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!response?.ok) return null;
  const { messages = [] } = await response.json();
  const mention = new RegExp(`@${me}(?![A-Za-z0-9_])`, 'i');
  const lastOwn = messages.findLast((message) => message.sender === me);
  const call = messages.findLast((message) => message.sender === 'yeebyor' && mention.test(message.message));
  if (!call || (lastOwn && Number(lastOwn.id) > Number(call.id))) return null;
  return { action: 'owner_message', message_id: call.id, from: 'yeebyor', text: call.message,
    why: `yeebyor called you in the room. Reply there now: chat.mjs ${me} wait ${room} --timeout 30, then chat.mjs ${me} send ${room} --file <reply> --last-seen <turn.last_id>, then chat.mjs ${me} leave ${room}. Then run next again and go on with your work.` };
}

// Notes on DONE tasks that arrived after the task's last submit, so its holder never had
// to act on them. One is settled once a task is created after it, or once the orchestrator
// answers with its own note on that task. The orchestrator's own notes are answers, or
// findings it already knows about, so they never count as follow-ups.
async function followUps(tasks, orchestrator) {
  const created = tasks.map((task) => Date.parse(task.created_at));
  const open = [];
  for (const task of tasks.filter((item) => item.status === 'DONE')) {
    const events = (await api('task_get', { task: task.id })).events;
    const lastSubmit = events.filter((event) => event.op === 'submit').at(-1)?.id ?? 0;
    for (const note of events.filter((event) => event.op === 'note' && event.id > lastSubmit && event.actor !== orchestrator)) {
      const at = Date.parse(note.at);
      const answered = created.some((time) => time > at)
        || events.some((event) => event.op === 'note' && event.actor === orchestrator && event.id > note.id);
      if (!answered) open.push({ task: task.id, title: task.title, from: note.actor, text: note.reason });
    }
  }
  return open;
}

function globRegex(pattern) {
  const source = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map((part) => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[part]
    ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${source}$`);
}

async function context(id) {
  const task = await api('task_get', { task: id });
  const charter = await checkMain(task.room);
  return { task, charter: charter.charter, project: charter.charter.project_path };
}

if (command === 'charter') {
  print(flags.file ? await api('charter_set', { room: target, charter: JSON.parse(text(flags.file)) }) : await api('charter_get', { room: target }));
} else if (command === 'board') {
  print(await api('board', { room: target }));
} else if (command === 'task') {
  print(await api('task_get', { task: target }));
} else if (command === 'decisions') {
  print((await api('board', { room: target })).decisions);
} else if (command === 'decide') {
  // Check the existing keys with "decisions" first: reuse a key for the same topic.
  print(await api('decision_add', {
    room: target, key: need('key'), title: need('title'), body: text(need('file')),
    ...(flags.supersedes ? { supersedes: flags.supersedes } : {}),
  }));
} else if (command === 'resolve') {
  print(await api('decision_resolve', { decision: target, choice: words[0], reason: need('reason') }));
} else if (command === 'next') {
  // What should this agent do now? Polls until there is an action, keeping the
  // agent's claims alive meanwhile. Exit 0 = act on "action", 2 = keep waiting
  // (run next again), 3 = project closed. Agents stop only when the project is closed:
  // while it is open the orchestrator may still add follow-up tasks for anyone.
  if (me === 'yeebyor') throw new Error('next is for agents.');
  const deadline = Date.now() + Number(flags.timeout || 90) * 1000;
  const { charter } = await api('charter_get', { room: target });
  const orchestrator = charter.orchestrator === me;
  while (true) {
    const board = await api('board', { room: target });
    if (board.project.closed_at) { print({ action: 'closed', room: target }); process.exitCode = 3; break; }
    const tasks = board.tasks;
    // yeebyor called this agent in the room: answer first, then go on with the work.
    const call = await ownerCall(target);
    if (call) { print(call); break; }
    const done = (id) => tasks.find((task) => task.id === id)?.status === 'DONE';
    const mine = tasks.filter((task) => task.team === me);
    for (const task of mine.filter((item) => item.status === 'CLAIMED')) {
      await api('task_heartbeat', { task: task.id, generation: task.generation });
    }
    const pick = (action, list, why) => list.length ? { action, task: list[0].id, title: list[0].title, why } : null;
    // A decision conflict the orchestrator may settle: neither side is its own.
    const conflicts = (board.decisions ?? []).filter((item) => item.status === 'conflict');
    const byId = new Map((board.decisions ?? []).map((item) => [item.id, item]));
    const settle = orchestrator ? conflicts.find((item) => ![item.actor, byId.get(item.conflicts_with)?.actor].includes(me)) : undefined;
    let found = (settle ? { action: 'resolve', decision: settle.id, key: settle.key,
      why: `Decision conflict on "${settle.key}" (#${settle.conflicts_with} versus #${settle.id}): read both with decisions, then resolve keep or replace with a reason.` } : null)
      ?? pick('integrate', mine.filter((task) => task.status === 'APPROVED'), 'Your task was approved: run integrate.')
      ?? pick('review', tasks.filter((task) => task.status === 'REVIEW' && task.team !== me), 'Another team\'s task is waiting for verify and review.')
      ?? pick('work', mine.filter((task) => task.status === 'CLAIMED'), 'You hold this task: continue, commit, then submit.')
      ?? pick('claim', mine.filter((task) => task.status === 'TODO' && task.depends_on.every(done)), 'This task is ready to claim.')
      ?? (orchestrator && !tasks.length ? { action: 'plan', why: 'No tasks yet: announce the split in the room, then create tasks that follow the charter.' } : null)
      // A project with an open decision conflict cannot close yet, so it is not all done.
      ?? (orchestrator && tasks.length && !conflicts.length && tasks.every((task) => ['DONE', 'CANCELLED'].includes(task.status))
        ? { action: 'all_done', why: 'Every task is done. Call @yeebyor to assess and close the project.' } : null);
    // Late findings on finished tasks come before all_done: the orchestrator creates a
    // follow-up task, or answers with a note saying why no change is needed.
    if (orchestrator && (!found || found.action === 'all_done')) {
      const late = await followUps(tasks, me);
      if (late.length) found = { action: 'follow_up', task: late[0].task, title: late[0].title, notes: late,
        why: 'A reviewer added findings after this task was approved. Create a follow-up task for them, or answer with note <task> explaining why no change is needed.' };
    }
    if (found) {
      // The holder sees every finding of this round, also from a second reviewer whose
      // task was already returned; a reviewer of a resubmission sees the last round's.
      if (found.action === 'work') {
        const items = await feedback(found.task);
        if (items.length) Object.assign(found, { feedback: items, why: 'You hold this task: address every item in feedback, commit, then submit.' });
      } else if (found.action === 'review') {
        const items = await feedback(found.task, true);
        if (items.length) Object.assign(found, { previous_feedback: items, why: 'Another team\'s task is waiting for verify and review. Check that every item in previous_feedback was addressed.' });
      }
      print(found);
      break;
    }
    if (Date.now() >= deadline) {
      // Still waiting: say on what, so the agent does not mistake waiting for being done.
      const open = mine.filter((task) => !['DONE', 'CANCELLED'].includes(task.status)).map((task) => `#${task.id} ${task.status}`);
      const finished = tasks.length && tasks.every((task) => ['DONE', 'CANCELLED'].includes(task.status));
      print({ action: 'waiting', why: finished
        ? 'Every task is done, but the project is still open: the orchestrator may add follow-up tasks and yeebyor may call you. Run next again; stop only at closed.'
        : 'Nothing for you to do yet. Run next again; do not stop.', yours: open,
        ...(conflicts.length ? { conflicts: conflicts.map((item) => `#${item.id} "${item.key}" waits for a decision by yeebyor or the orchestrator`) } : {}) });
      process.exitCode = 2;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
} else if (command === 'wait') {
  // Waits for one task to reach one of the given statuses. Exit 0 reached, 2 keep waiting, 3 blocked.
  const until = need('until').split(',').map((status) => status.trim().toUpperCase());
  const deadline = Date.now() + Number(flags.timeout || 90) * 1000;
  while (true) {
    const task = await api('task_get', { task: target });
    const summary = { task: task.id, status: task.status, team: task.team };
    if (until.includes(task.status)) { print({ result: 'reached', ...summary }); break; }
    if (task.status === 'BLOCKED') { print({ result: 'blocked', ...summary, reason: task.block_reason }); process.exitCode = 3; break; }
    if (Date.now() >= deadline) { print({ result: 'waiting', ...summary }); process.exitCode = 2; break; }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
} else if (command === 'orchestrator') {
  // Owner only: hand the orchestrator role to another leader. This writes the same
  // charter as a new version with only the orchestrator changed.
  const name = words[0];
  if (!['Claude', 'GPT', 'Gemini'].includes(name)) throw new Error('Pass the new orchestrator: Claude, GPT, or Gemini.');
  const { charter } = await api('charter_get', { room: target });
  print(await api('charter_set', { room: target, charter: { ...charter, orchestrator: name } }));
} else if (command === 'setup') {
  // Owner only, same as the room's "Set up project" form: repo, worktrees, main hash.
  print(await local('setup', { room: target }));
} else if (command === 'main-set') {
  print(await local('main_set', { room: target, reason: need('reason') }));
} else if (command === 'create') {
  print(await api('task_create', {
    room: target, title: need('title'), team: need('team'),
    ...(flags.file ? { description: text(flags.file) } : {}),
    ...(flags.depends ? { depends_on: flags.depends.split(',').map((id) => id.trim()) } : {}),
  }));
} else if (['cancel', 'reassign', 'block', 'unblock', 'exception'].includes(command)) {
  print(await api(`task_${command}`, { task: target, reason: need('reason'), ...(flags.team ? { team: flags.team } : {}) }));
} else if (command === 'claim') {
  print(await api('task_claim', { task: target }));
} else if (command === 'heartbeat') {
  const task = await api('task_get', { task: target });
  print(await api('task_heartbeat', { task: target, generation: task.generation }));
} else if (command === 'delegate') {
  const task = await api('task_get', { task: target });
  print(await api('delegate', { task: target, generation: task.generation, label: need('label'), contract: text(need('file')) }));
} else if (command === 'child') {
  print(await api('child_close', { delegation: target, status: need('status'), ...(flags.file ? { result: text(flags.file) } : {}) }));
} else if (command === 'submit') {
  // The candidate is the committed head of the team branch, tested in a clean checkout.
  const { task, charter, project } = await context(target);
  const tree = teamTree(project, me);
  if (git(tree, 'status', '--porcelain')) throw new Error(`Worktree ${tree} has uncommitted changes. Commit first.`);
  const commit = git(tree, 'rev-parse', 'HEAD');
  const saved = await evidence(task.room, task.id, 'submit', commit, scratch(project, commit), charter.test_command);
  if (!saved.passed) process.exit(1);
  print(await api('task_submit', { task: task.id, generation: task.generation, commit, evidence: saved.evidence }));
} else if (command === 'verify') {
  // The reviewer runs the tests on the candidate personally.
  const { task, charter, project } = await context(target);
  if (task.status !== 'REVIEW') throw new Error(`The task status is ${task.status}, not REVIEW.`);
  const saved = await evidence(task.room, task.id, 'verify', task.candidate, scratch(project, task.candidate), charter.test_command);
  print({ evidence: saved.evidence, passed: saved.passed, commit: task.candidate });
} else if (command === 'review') {
  const verdict = words[0];
  const task = await api('task_get', { task: target });
  // Approval uses the caller's latest passing verify run on the current candidate.
  const own = task.evidence.filter((item) => item.kind === 'verify' && item.actor === me && item.commit === task.candidate
    && item.exit_code === 0 && !item.timed_out).at(-1);
  const notes = text(need('file'));
  // Another reviewer got there first (the task left REVIEW): keep the findings as a note
  // instead of losing them, so the holder or the orchestrator still sees them.
  const late = async (status) => {
    const saved = await api('task_note', { task: target, note: `Review notes (${verdict}), filed as a note because the task was already ${status}:\n\n${notes}` });
    console.error(`The task is ${status}, so your review was saved as a note.`);
    print({ filed_as: 'note', task: saved.id, status: saved.status });
  };
  if (task.status !== 'REVIEW' && task.status !== 'CANCELLED') await late(task.status);
  else {
    if (verdict === 'approve' && !own) throw new Error('Run hfma.mjs verify first; an approval needs your own passing tests.');
    try {
      print(await api('task_review', { task: target, verdict, commit: task.candidate, notes, ...(own ? { evidence: own.id } : {}) }));
    } catch (error) {
      const now = await api('task_get', { task: target });
      if (now.status === 'REVIEW' || now.status === 'CANCELLED') throw error;
      await late(now.status);
    }
  }
} else if (command === 'note') {
  // A finding for the team holding the task, e.g. when another reviewer already returned it.
  print(await api('task_note', { task: target, note: text(need('file')) }));
} else if (command === 'integrate') {
  const { task, charter, project } = await context(target);
  if (task.status !== 'APPROVED') throw new Error(`The task status is ${task.status}, not APPROVED.`);
  // Failed outcomes also say why on stderr; the database keeps the same reason in the task's events.
  const report = (outcome, extra = {}, why = extra.reason) => {
    if (why) console.error(`integrate ${outcome}: ${why}`);
    return api('task_integrate', { task: task.id, commit: task.approved_hash, outcome, ...extra });
  };
  // 1. The approval covers one commit; a branch that moved since needs a new submit.
  if (git(project, 'rev-parse', `team/${task.team}`) !== task.approved_hash) {
    print(await report('moved', {}, `team/${task.team} moved after it was approved; the task is back to CLAIMED, submit again.`));
    process.exit(1);
  }
  // 2. Files outside the team's paths wait for yeebyor unless an exception exists.
  const main = git(project, 'rev-parse', 'main');
  const changed = git(project, 'diff', '--name-only', `${main}...${task.approved_hash}`).split('\n').filter(Boolean);
  const allowed = (charter.ownership[task.team] ?? []).map(globRegex);
  const outside = changed.filter((file) => !allowed.some((pattern) => pattern.test(file)));
  if (outside.length && !task.exception) {
    print(await report('ownership', { files: outside.join(', ').slice(0, 4000) },
      `files outside team ${task.team}'s paths: ${outside.join(', ')}. The task is BLOCKED until yeebyor grants an exception.`));
    process.exit(1);
  }
  // 3. Merge onto main in a scratch checkout and test the combined result.
  const path = scratch(project, main);
  if (!tryGit(path, ...as, 'merge', '--no-ff', '--no-edit', task.approved_hash)) {
    tryGit(path, 'merge', '--abort');
    print(await report('failed', { reason: 'Merge conflict with main. Merge main into the team branch, then submit again.' }));
    process.exit(1);
  }
  const merged = git(path, 'rev-parse', 'HEAD');
  const saved = await evidence(task.room, task.id, 'integrate', merged, path, charter.test_command);
  if (!saved.passed) {
    print(await report('failed', { reason: 'Tests failed on the result merged with main.', evidence: saved.evidence }));
    process.exit(1);
  }
  // 4. Record first, then fast-forward main in the project folder (which has main
  // checked out). If git refuses now, e.g. someone edited that folder, the next
  // check finds main behind the recorded hash and freezes integration.
  // base lets the database refuse this merge if another integrate moved main meanwhile.
  const done = await report('merged', { merge_hash: merged, base: main, evidence: saved.evidence, ownership_ok: true });
  if (git(project, 'symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error(`Folder ${project} is not on the main branch.`);
  git(project, 'merge', '--ff-only', merged);
  print(done);
} else if (command === 'close') {
  // Owner only, same as the board's "Close project": the server runs every command
  // criterion on main, then asks the database to close.
  const result = await local('close', { room: target, owner_criteria: flags.owner ? flags.owner.split(',').map((id) => id.trim()) : [] });
  for (const item of result.results) console.error(`close ${item.id}: ${item.passed ? 'PASSED' : 'FAILED'} (exit ${item.exit_code}, ${item.duration_ms} ms)`);
  print(result);
  if (!result.closed) process.exitCode = 1;
} else {
  throw new Error(`Unknown command ${command}.\n${USAGE}`);
}
