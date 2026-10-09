import type { ChatMessage } from "./chat-types";
import type { ExportFormat } from "./chat-export";

// Export for a room with an HFMA charter: chat messages and what actually happened
// (claims, test runs, reviews, integrations with their commits) on one timeline, then
// every charter version, the tasks, and the commits. Commit details come from git on
// this machine (POST /api/hfma/local, action "record"); test output is included in full.

type Hash = string | null;
interface RecordEvent { id: number; task_id: number | null; actor: string; op: string; generation: number | null; commit: Hash; evidence_id: number | null; charter_version: number | null; reason: string | null; at: string }
interface RecordTask { id: number; title: string; team: string; status: string; generation: number; candidate: Hash; approved_hash: Hash; merge_hash: Hash }
interface RecordReview { id: number; task_id: number; reviewer: string; verdict: string; commit: string; notes: string }
interface RecordEvidence { id: number; task_id: number | null; kind: string; criterion: string | null; commit: string; command: string; exit_code: number | null; timed_out: boolean; duration_ms: number; output: string; actor: string }
interface RecordDelegation { id: number; task_id: number; leader: string; label: string; contract: string; status: string; result: string | null; closed_at: string | null }
interface RecordDecision { id: number; key: string; title: string; body: string; actor: string; status: string; resolved_by: string | null; resolution: string | null }
interface Commit { hash: string; subject: string; author: string; date: string; merge: boolean; files: { status: string; path: string }[] }
export interface ProjectRecord {
  record: {
    charters: { version: number; body: unknown; created_at: string }[];
    project: { main_hash: Hash; inconsistent: boolean; closed_at: string | null } | null;
    tasks: RecordTask[]; reviews: RecordReview[]; evidence: RecordEvidence[]; delegations: RecordDelegation[]; events: RecordEvent[];
    decisions?: RecordDecision[];
  };
  commits: Record<string, Commit | null>;
  git: boolean;
}

// One timeline entry; blocks are rendered as paragraphs or, when code, verbatim.
type Block = { label: string; text: string; code?: boolean };
type Entry = { at: string; order: number; who: string; title: string; blocks: Block[] };

const pad = (value: number) => String(value).padStart(2, "0");
function stamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
const short = (hash: Hash) => hash ? hash.slice(0, 7) : "?";
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function buildEntries(messages: ChatMessage[], data: ProjectRecord): Entry[] {
  const { record, commits } = data;
  const tasks = new Map(record.tasks.map((task) => [task.id, task]));
  const evidence = new Map(record.evidence.map((item) => [item.id, item]));
  const reviews = [...record.reviews];
  const decisionById = new Map((record.decisions ?? []).map((item) => [item.id, item]));
  const delegations = [...record.delegations];
  // The full title appears where a task is created; later lines just say #id.
  const taskName = (id: number | null) => `#${id}`;
  const fullName = (id: number | null) => {
    const task = id === null ? undefined : tasks.get(id);
    return task ? `#${task.id} "${task.title}"` : `#${id}`;
  };
  const commitBlock = (hash: Hash, label = "Commit"): Block[] => {
    if (!hash) return [];
    const info = commits[hash];
    if (!info) return [{ label, text: data.git ? `${hash} (not in the repo any more)` : hash }];
    const files = info.files.map((file) => `${file.status} ${file.path}`).join("\n");
    return [{ label, text: `${info.hash}\n${info.subject}\n${info.author}, ${stamp(info.date)}${files ? `\n\n${files}` : ""}`, code: true }];
  };
  // A review or delegation is matched to its event once, in order.
  const take = <T,>(list: T[], match: (item: T) => boolean) => {
    const index = list.findIndex(match);
    return index < 0 ? undefined : list.splice(index, 1)[0];
  };

  const entries: Entry[] = messages.map((message, i) => ({
    at: message.created_at, order: i, who: message.sender, title: "chat", blocks: [{ label: "", text: message.message }],
  }));

  for (const event of record.events) {
    const task = taskName(event.task_id);
    const reason = event.reason ? [{ label: "Reason", text: event.reason }] : [];
    let title = `${event.op} ${event.task_id !== null ? task : ""}`.trim();
    let blocks: Block[] = reason;
    if (event.op === "charter_set") title = `set the charter (version ${event.charter_version})`;
    else if (event.op === "main_set") { title = `accepted main at ${short(event.commit)}`; blocks = [...reason, ...commitBlock(event.commit)]; }
    else if (event.op === "main_inconsistent") title = event.reason?.startsWith("Uncommitted") ? "reported changes in the project folder itself" : "reported that main changed outside integrate";
    else if (event.op === "create") {
      const created = event.task_id !== null ? tasks.get(event.task_id) : undefined;
      title = `created ${fullName(event.task_id)}${created ? ` for ${created.team}` : ""}`;
    } else if (event.op === "claim") title = `claimed ${task} (generation ${event.generation})`;
    else if (event.op.startsWith("evidence_")) {
      const run = event.evidence_id !== null ? evidence.get(event.evidence_id) : undefined;
      const kind = event.op.slice("evidence_".length);
      const passed = run && run.exit_code === 0 && !run.timed_out;
      title = `ran ${kind}${run?.criterion ? ` for ${run.criterion}` : event.task_id !== null ? ` for ${task}` : ""} on ${short(event.commit)}: `
        + (run ? `${passed ? "passed" : run.timed_out ? "timed out" : `failed (exit ${run.exit_code})`} in ${seconds(run.duration_ms)}` : event.reason ?? "");
      blocks = run ? [{ label: "Command", text: run.command, code: true }, { label: "Output", text: run.output || "(no output)", code: true }] : [];
    } else if (event.op === "submit") { title = `submitted ${task} at ${short(event.commit)}`; blocks = commitBlock(event.commit); }
    else if (event.op === "approve" || event.op === "reject") {
      const review = take(reviews, (item) => item.task_id === event.task_id && item.reviewer === event.actor && item.verdict === event.op && item.commit === event.commit);
      title = `${event.op === "approve" ? "approved" : "rejected"} ${task} at ${short(event.commit)}`;
      blocks = review ? [{ label: "Review notes", text: review.notes }] : [];
    } else if (event.op === "integrate") {
      const integrated = event.task_id !== null ? tasks.get(event.task_id) : undefined;
      title = `integrated ${task} into main as ${short(event.commit)}`;
      blocks = [...commitBlock(integrated?.approved_hash ?? null, "Approved commit"), ...commitBlock(event.commit, "Merge into main")];
    } else if (event.op === "integrate_moved") title = `integrate of ${task} stopped: the team branch moved after approval`;
    else if (event.op === "integrate_failed") { title = `integrate of ${task} failed`; blocks = [...reason, ...commitBlock(event.commit)]; }
    else if (event.op === "delegate") {
      const delegation = delegations.find((item) => item.task_id === event.task_id && item.label === event.reason);
      title = `delegated "${event.reason}" on ${task} to a sub-agent`;
      blocks = delegation ? [{ label: "Contract", text: delegation.contract }] : [];
    } else if (event.op.startsWith("child_")) {
      const status = event.op.slice("child_".length);
      const delegation = take(delegations, (item) => item.task_id === event.task_id && item.status === status && item.closed_at !== null);
      title = `closed sub-agent work${delegation ? ` "${delegation.label}"` : ""} on ${task} as ${status}`;
      blocks = delegation?.result ? [{ label: "Result", text: delegation.result }] : [];
    } else if (event.op === "close") { title = `closed the project at main ${short(event.commit)}`; blocks = commitBlock(event.commit); }
    else if (["block", "unblock", "exception", "cancel", "reassign"].includes(event.op)) title = `${event.op} ${task}`;
    else if (event.op === "note") { title = `added a review note on ${task}`; blocks = event.reason ? [{ label: "Note", text: event.reason }] : []; }
    else if (event.op === "decision" || event.op === "decision_conflict") {
      // The reason reads "#id key: title"; the decision itself carries the full text.
      const decision = decisionById.get(Number(/^#(\d+)/.exec(event.reason ?? "")?.[1]));
      title = `${event.op === "decision" ? "recorded decision" : "recorded a CONFLICTING decision"} ${event.reason ?? ""}`;
      blocks = decision ? [{ label: "Decision", text: decision.body }] : [];
    } else if (event.op === "decision_resolve") {
      title = `resolved a decision conflict ${event.reason ?? ""}`;
      blocks = [];
    }
    entries.push({ at: event.at, order: messages.length + event.id, who: event.actor, title, blocks });
  }
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
}

// Fences that a block's own text cannot close early.
const fence = (text: string) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));

export function formatProjectExport(format: ExportFormat, room: string, messages: ChatMessage[], data: ProjectRecord): { content: string; mime: string } {
  if (format === "json") {
    return {
      mime: "application/json",
      content: JSON.stringify({ room, exported_at: new Date().toISOString(), messages, record: data.record, commits: data.commits }, null, 2),
    };
  }
  const { record, commits } = data;
  const latest = record.charters.at(-1);
  const project = record.project;
  const status = project?.closed_at ? `closed ${stamp(project.closed_at)}` : "open";
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const summary = `Exported ${stamp(new Date().toISOString())} · ${count(messages.length, "message")} · ${count(record.tasks.length, "task")} · charter version ${latest?.version ?? "-"} · ${status} · main ${short(project?.main_hash ?? null)}`;
  const entries = buildEntries(messages, data);
  // Final state of every decision, so the reader sees what the project settled on.
  const decisionLines = (record.decisions ?? []).map((item) => `[${item.status}] ${item.key}: ${item.title} (#${item.id} by ${item.actor})`
    + (item.resolution ? `. Resolved by ${item.resolved_by}: ${item.resolution}` : ""));
  const knownCommits = Object.values(commits).filter((commit): commit is Commit => commit !== null)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  if (format === "md") {
    const block = (item: Block) => item.code
      ? `${item.label ? `**${item.label}**\n\n` : ""}${fence(item.text)}\n${item.text}\n${fence(item.text)}`
      : `${item.label ? `**${item.label}:** ` : ""}${item.text}`;
    const timeline = entries.map((entry) => [`### ${stamp(entry.at)} · ${entry.who} · ${entry.title}`, ...entry.blocks.map(block)].join("\n\n")).join("\n\n");
    const charters = record.charters.map((charter) => {
      const text = JSON.stringify(charter.body, null, 2);
      return `### Version ${charter.version} · ${stamp(charter.created_at)}\n\n${fence(text)}json\n${text}\n${fence(text)}`;
    }).join("\n\n");
    const tasks = ["| Task | Team | Status | Merged as |", "| --- | --- | --- | --- |",
      ...record.tasks.map((task) => `| #${task.id} ${task.title.replaceAll("|", "\\|")} | ${task.team} | ${task.status} | ${task.merge_hash ? short(task.merge_hash) : ""} |`)].join("\n");
    const commitList = knownCommits.map((commit) => `- \`${short(commit.hash)}\` ${commit.subject} (${commit.author}, ${stamp(commit.date)}, ${commit.files.length} files)`).join("\n");
    return {
      mime: "text/markdown",
      content: [`# Project record: ${room}`, summary, "## Timeline", timeline, "## Charter", charters, "## Tasks", tasks,
        "## Decisions", decisionLines.map((line) => `- ${line}`).join("\n") || "No decisions recorded.",
        "## Commits", data.git ? commitList || "No commits recorded." : "The project folder was not found, so commit details are missing."].join("\n\n") + "\n",
    };
  }
  const indent = (text: string) => text.split("\n").map((line) => `    ${line}`).join("\n");
  const block = (item: Block) => item.code ? `  ${item.label}:\n${indent(item.text)}` : `  ${item.label ? `${item.label}: ` : ""}${item.text}`;
  const timeline = entries.map((entry) => [`[${stamp(entry.at)}] ${entry.who}: ${entry.title}`, ...entry.blocks.map(block)].join("\n")).join("\n\n");
  const charters = record.charters.map((charter) => `Version ${charter.version} (${stamp(charter.created_at)})\n${indent(JSON.stringify(charter.body, null, 2))}`).join("\n\n");
  const tasks = record.tasks.map((task) => `#${task.id} ${task.title} | ${task.team} | ${task.status}${task.merge_hash ? ` | merged as ${short(task.merge_hash)}` : ""}`).join("\n");
  const commitList = knownCommits.map((commit) => `${short(commit.hash)} ${commit.subject} (${commit.author}, ${stamp(commit.date)}, ${commit.files.length} files)`).join("\n");
  return {
    mime: "text/plain",
    content: [`Project record: ${room}`, summary, "TIMELINE", timeline, "CHARTER", charters, "TASKS", tasks,
      "DECISIONS", decisionLines.join("\n") || "No decisions recorded.",
      "COMMITS", data.git ? commitList || "No commits recorded." : "The project folder was not found, so commit details are missing."].join("\n\n") + "\n",
  };
}
