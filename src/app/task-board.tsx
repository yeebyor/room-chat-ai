"use client";

import { useState } from "react";
import { AlertTriangle, Check, GitCommitHorizontal, Loader2, Lock, X } from "lucide-react";
import type { Agent, CriterionRun, HfmaBoard, HfmaDecision, HfmaTask, LocalResult, TaskStatus } from "@/lib/chat-types";
import { CharterEditor } from "./charter-editor";

// The room's HFMA tasks, plus the owner's decisions. Agents work through
// scripts/hfma.mjs; the browser session is always yeebyor, so the actions here
// are the owner's: reassign, unblock, exception, cancel, and the orchestrator
// (database operations, each with a reason), plus accepting main, finishing
// setup, and closing (git on this machine, through src/app/api/hfma/local).
type Action = (op: string, args: Record<string, unknown>) => Promise<string | null>;
const AGENTS: Agent[] = ["Claude", "GPT", "Gemini"];
const OPEN: TaskStatus[] = ["TODO", "CLAIMED", "REVIEW", "APPROVED", "BLOCKED"];
const focusRing = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40";
const smallButton = `rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-white/[0.14] hover:text-white disabled:opacity-50 ${focusRing}`;
const field = "rounded-lg border border-white/15 bg-white/[0.08] px-2.5 py-1.5 text-xs text-white placeholder-zinc-500 outline-none focus:border-white/35";

type Kind = "reassign" | "unblock" | "exception" | "block" | "cancel";
const LABEL: Record<Kind, string> = { reassign: "Reassign", unblock: "Unblock", exception: "Exception", block: "Block", cancel: "Cancel task" };

function actionsFor(task: HfmaTask): Kind[] {
  if (!OPEN.includes(task.status)) return [];
  const kinds: Kind[] = task.status === "BLOCKED" ? ["unblock"] : [];
  if (["BLOCKED", "APPROVED"].includes(task.status) && !task.exception) kinds.push("exception");
  if (task.status !== "BLOCKED") kinds.push("block");
  return [...kinds, "reassign", "cancel"];
}

function TaskActions({ task, onAction }: { task: HfmaTask; onAction: Action }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [reason, setReason] = useState("");
  const [team, setTeam] = useState<Agent>(task.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const kinds = actionsFor(task);
  if (!kinds.length) return null;

  const close = () => { setKind(null); setReason(""); setError(""); setTeam(task.team); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!kind || !reason.trim()) { setError("Write the reason first."); return; }
    setBusy(true);
    const failure = await onAction(`task_${kind}`, { task: task.id, reason: reason.trim(), ...(kind === "reassign" ? { team } : {}) });
    setBusy(false);
    if (failure) setError(failure); else close();
  };

  if (!kind) {
    return (
      <div role="group" aria-label={`Actions for task ${task.id}`} className="mt-2 flex flex-wrap gap-1.5">
        {kinds.map((item) => <button key={item} type="button" onClick={() => setKind(item)} className={smallButton}>{LABEL[item]}</button>)}
      </div>
    );
  }
  return (
    <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") close(); }} className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {kind === "reassign" && (
          <select value={team} onChange={(event) => setTeam(event.target.value as Agent)} aria-label="New team" className={field}>
            {AGENTS.map((agent) => <option key={agent} value={agent} className="bg-zinc-900">{agent}</option>)}
          </select>
        )}
        <input
          autoFocus value={reason} maxLength={2000} disabled={busy}
          onChange={(event) => { setReason(event.target.value); setError(""); }}
          placeholder={`Reason to ${LABEL[kind].toLowerCase()}`} aria-label={`Reason to ${LABEL[kind].toLowerCase()}`}
          className={`${field} min-w-0 flex-1`}
        />
      </div>
      <div className="flex gap-1.5">
        <button type="button" onClick={close} disabled={busy} className={smallButton}>Back</button>
        <button type="submit" disabled={busy} className={`${smallButton} ${kind === "cancel" ? "border-red-400/40 bg-red-500/20 text-red-100 hover:bg-red-500/30" : "border-white/30 bg-white/[0.14]"}`}>
          {busy ? "Saving..." : LABEL[kind]}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
    </form>
  );
}

type Local = (body: Record<string, unknown>) => Promise<LocalResult>;

// main moved outside integrate: after checking it, the owner accepts the current main.
function AcceptMain({ room, onLocal }: { room: string; onLocal: Local }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) { setError("Write what you checked first."); return; }
    setBusy(true);
    const result = await onLocal({ action: "main_set", room, reason: reason.trim() });
    setBusy(false);
    if (result.error) setError(result.error); else setReason("");
  };
  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap gap-1.5">
      <input value={reason} onChange={(event) => { setReason(event.target.value); setError(""); }} maxLength={2000} disabled={busy}
        placeholder="What you checked on main" aria-label="Reason to accept the current main" className={`${field} min-w-0 flex-1`} />
      <button type="submit" disabled={busy} className={smallButton}>{busy ? "Saving..." : "Accept current main"}</button>
      {error && <p role="alert" className="w-full text-red-200">{error}</p>}
    </form>
  );
}

function RunResult({ run }: { run: CriterionRun }) {
  const Icon = run.passed ? Check : X;
  return (
    <li className="rounded-lg border border-white/[0.12] bg-white/[0.04] px-2.5 py-2 text-xs">
      <span className={`flex items-center gap-1.5 ${run.passed ? "text-emerald-200" : "text-red-200"}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {run.id} {run.passed ? "passed" : run.timed_out ? "timed out" : `failed (exit ${run.exit_code})`}
        <span className="text-zinc-500">{Math.round(run.duration_ms / 1000)} s</span>
      </span>
      {!run.passed && <pre className="chat-scroll mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-300">{run.output}</pre>}
    </li>
  );
}

// Closing is final. Command criteria run on main now; the owner confirms the rest.
function ClosePanel({ board, onLocal, onDone }: { board: HfmaBoard; onLocal: Local; onDone: () => void }) {
  const criteria = board.criteria ?? [];
  const owned = criteria.filter((item) => item.check === "owner");
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LocalResult | null>(null);
  const ready = owned.every((item) => confirmed.includes(item.id));
  const run = async () => {
    setBusy(true);
    setResult(null);
    const outcome = await onLocal({ action: "close", room: board.room, owner_criteria: confirmed });
    setBusy(false);
    setResult(outcome);
    if (!outcome.error) onDone();
  };
  return (
    <div className="mb-3 space-y-2 rounded-xl border border-white/20 bg-white/[0.06] p-3 text-xs text-zinc-300">
      <p className="text-sm text-white">Close project</p>
      <p>Closing is final: no task can be added afterwards. Command criteria run on main now; the rest needs your confirmation.</p>
      <ul className="space-y-1.5">
        {criteria.map((item) => (
          <li key={item.id}>
            {item.check === "owner" ? (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={confirmed.includes(item.id)} disabled={busy} className="mt-0.5 accent-white"
                  onChange={(event) => setConfirmed(event.target.checked ? [...confirmed, item.id] : confirmed.filter((id) => id !== item.id))} />
                <span><span className="text-zinc-500">{item.id}</span> I confirm: {item.text}</span>
              </label>
            ) : (
              <span className="flex items-start gap-2">
                <span className="text-zinc-500">{item.id}</span>
                <span>{item.text} <span className="font-mono text-[11px] text-zinc-500">runs: {item.command}</span></span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {busy && <p role="status" className="flex items-center gap-1.5 text-zinc-200"><Loader2 className="h-3.5 w-3.5 animate-spin" />Running the checks on main. This can take a few minutes.</p>}
      {result?.error && <p role="alert" className="text-red-200">{result.error}</p>}
      {result?.results && <ul className="space-y-1.5">{result.results.map((item) => <RunResult key={item.id} run={item} />)}</ul>}
      <button type="button" onClick={() => void run()} disabled={busy || !ready}
        className={`${smallButton} border-red-400/40 bg-red-500/20 text-red-100 hover:bg-red-500/30`}>
        {busy ? "Closing..." : ready ? "Run checks and close" : "Confirm your criteria first"}
      </button>
    </div>
  );
}

// Handing the role over writes the charter as a new version; the page does that part.
function OrchestratorControl({ current, onChange }: { current: Agent; onChange: (name: string) => Promise<string | null> }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pick = async (name: string) => {
    if (name === current) { setEditing(false); return; }
    setBusy(true);
    const failure = await onChange(name);
    setBusy(false);
    if (failure) setError(failure); else { setEditing(false); setError(""); }
  };
  return (
    <span className="flex items-center gap-1.5">
      {editing ? (
        <select autoFocus defaultValue={current} disabled={busy} aria-label="Orchestrator" onChange={(event) => void pick(event.target.value)}
          onBlur={() => !busy && setEditing(false)} className={field}>
          {AGENTS.map((agent) => <option key={agent} value={agent} className="bg-zinc-900">{agent}</option>)}
        </select>
      ) : (
        <button type="button" onClick={() => setEditing(true)} title="Change orchestrator" className={`underline decoration-white/30 underline-offset-2 hover:text-white ${focusRing}`}>
          orchestrator {current}
        </button>
      )}
      {error && <span role="alert" className="text-red-200">{error}</span>}
    </span>
  );
}
const ORDER: TaskStatus[] = ["BLOCKED", "REVIEW", "APPROVED", "CLAIMED", "TODO", "DONE", "CANCELLED"];
const BADGE: Record<TaskStatus, string> = {
  TODO: "border-white/15 text-zinc-300",
  CLAIMED: "border-sky-300/30 bg-sky-400/10 text-sky-100",
  REVIEW: "border-amber-300/30 bg-amber-400/10 text-amber-100",
  APPROVED: "border-emerald-300/30 bg-emerald-400/10 text-emerald-100",
  DONE: "border-emerald-300/40 bg-emerald-400/20 text-emerald-50",
  BLOCKED: "border-red-300/40 bg-red-500/20 text-red-100",
  CANCELLED: "border-white/10 text-zinc-500",
};

const short = (hash: string | null) => hash?.slice(0, 7) ?? null;

function TaskRow({ task, onAction }: { task: HfmaTask; onAction?: Action }) {
  // The commit that matters at each stage: merged, approved, then submitted.
  const commit = short(task.merge_hash ?? task.approved_hash ?? task.candidate);
  return (
    <li className="rounded-xl border border-white/[0.12] bg-white/[0.05] px-3 py-2.5 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-zinc-500">#{task.id}</span>
        <span className={`min-w-0 flex-1 truncate text-sm ${task.status === "CANCELLED" ? "text-zinc-500 line-through" : "text-white"}`} title={task.title}>
          {task.title}
        </span>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${BADGE[task.status]}`}>{task.status}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span>{task.team}</span>
        {task.generation > 0 && <span className="tabular-nums">gen {task.generation}</span>}
        {task.depends_on.length > 0 && <span className="tabular-nums">after {task.depends_on.map((id) => `#${id}`).join(", ")}</span>}
        {commit && (
          <span className="flex items-center gap-1 font-mono text-[11px]">
            <GitCommitHorizontal className="h-3 w-3" aria-hidden="true" />{commit}
          </span>
        )}
        {task.exception && <span className="text-amber-200">exception</span>}
        {task.stale && <span className="text-amber-200">claim stale</span>}
      </div>
      {task.status === "BLOCKED" && task.block_reason && <p className="mt-1.5 text-xs text-red-200">{task.block_reason}</p>}
      {onAction && <TaskActions task={task} onAction={onAction} />}
    </li>
  );
}

// The owner adds a task directly, for example a fix after judging the result.
function NewTask({ board, onAction, onDone }: { board: HfmaBoard; onAction: Action; onDone: () => void }) {
  const teams = board.agents?.length ? board.agents : AGENTS;
  const [title, setTitle] = useState("");
  const [team, setTeam] = useState<Agent>(teams[0]);
  const [description, setDescription] = useState("");
  const [after, setAfter] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) { setError("Give the task a title."); return; }
    setBusy(true);
    const failure = await onAction("task_create", {
      room: board.room, title: title.trim(), team,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(after.length ? { depends_on: after } : {}),
    });
    setBusy(false);
    if (failure) setError(failure); else onDone();
  };
  return (
    <form onSubmit={submit} className="mb-3 space-y-2 rounded-xl border border-white/20 bg-white/[0.06] p-3 text-xs text-zinc-300" aria-label="New task">
      <p className="text-sm text-white">New task</p>
      <div className="flex flex-wrap gap-1.5">
        <input autoFocus value={title} onChange={(event) => { setTitle(event.target.value); setError(""); }} maxLength={200} disabled={busy}
          placeholder="Title" aria-label="Task title" className={`${field} min-w-0 flex-1`} />
        <select value={team} onChange={(event) => setTeam(event.target.value as Agent)} disabled={busy} aria-label="Team" className={field}>
          {teams.map((agent) => <option key={agent} value={agent} className="bg-zinc-900">{agent}</option>)}
        </select>
      </div>
      <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={8000} disabled={busy}
        placeholder="What needs to be done (optional)" aria-label="Task description" className={`${field} w-full resize-y`} />
      {board.tasks.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-zinc-400">Starts after (optional)</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {board.tasks.filter((task) => task.status !== "CANCELLED").map((task) => (
              <label key={task.id} className="flex items-center gap-1.5" title={task.title}>
                <input type="checkbox" checked={after.includes(task.id)} disabled={busy} className="accent-white"
                  onChange={(event) => setAfter(event.target.checked ? [...after, task.id] : after.filter((id) => id !== task.id))} />
                #{task.id}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error && <p role="alert" className="text-red-200">{error}</p>}
      <div className="flex gap-1.5">
        <button type="button" onClick={onDone} disabled={busy} className={smallButton}>Cancel</button>
        <button type="submit" disabled={busy} className={`${smallButton} border-white/30 bg-white/[0.14]`}>{busy ? "Adding..." : "Add task"}</button>
      </div>
    </form>
  );
}

function DecisionText({ decision }: { decision: HfmaDecision }) {
  return (
    <details className="inline">
      <summary className={`inline cursor-pointer list-none text-zinc-200 ${focusRing}`}>
        <span className="text-zinc-500">#{decision.id}</span> {decision.title} <span className="text-zinc-500">by {decision.actor}</span>
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-zinc-400">{decision.body}</p>
      {decision.resolution && <p className="mt-1 text-zinc-500">Resolved by {decision.resolved_by}: {decision.resolution}</p>}
    </details>
  );
}

// Two decisions on one topic: the owner keeps the active one or takes the new one.
function Conflict({ decision, current, onAction, open }: { decision: HfmaDecision; current?: HfmaDecision; onAction: Action; open: boolean }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = async (choice: "keep" | "replace") => {
    if (!reason.trim()) { setError("Write the reason first."); return; }
    setBusy(true);
    const failure = await onAction("decision_resolve", { decision: decision.id, choice, reason: reason.trim() });
    setBusy(false);
    if (failure) setError(failure);
  };
  return (
    <li className="space-y-2 rounded-xl border border-red-300/30 bg-red-500/10 px-3 py-2.5 text-xs">
      <p className="text-red-100">Conflict on <span className="font-mono">{decision.key}</span></p>
      {current && <div><span className="text-zinc-500">Active: </span><DecisionText decision={current} /></div>}
      <div><span className="text-zinc-500">New: </span><DecisionText decision={decision} /></div>
      {open && (
        <div className="flex flex-wrap gap-1.5">
          <input value={reason} onChange={(event) => { setReason(event.target.value); setError(""); }} maxLength={2000} disabled={busy}
            placeholder="Why" aria-label={`Reason for the decision on ${decision.key}`} className={`${field} min-w-0 flex-1`} />
          <button type="button" onClick={() => void choose("keep")} disabled={busy} className={smallButton}>Keep #{current?.id ?? decision.conflicts_with}</button>
          <button type="button" onClick={() => void choose("replace")} disabled={busy} className={smallButton}>Use #{decision.id}</button>
        </div>
      )}
      {error && <p role="alert" className="text-red-200">{error}</p>}
    </li>
  );
}

function Decisions({ board, onAction, open }: { board: HfmaBoard; onAction: Action; open: boolean }) {
  const decisions = board.decisions ?? [];
  if (!decisions.length) return null;
  const byId = new Map(decisions.map((item) => [item.id, item]));
  const conflicts = decisions.filter((item) => item.status === "conflict");
  const active = decisions.filter((item) => item.status === "active");
  const history = decisions.filter((item) => item.status === "superseded" || item.status === "rejected");
  return (
    <section className="mt-4 space-y-2" aria-label="Decisions">
      <p className="text-xs font-medium tracking-wide text-zinc-300">Decisions</p>
      {conflicts.length > 0 && (
        <ul className="space-y-2">
          {conflicts.map((item) => <Conflict key={item.id} decision={item} current={byId.get(item.conflicts_with ?? -1)} onAction={onAction} open={open} />)}
        </ul>
      )}
      {active.length > 0 && (
        <ul className="space-y-1.5">
          {active.map((item) => (
            <li key={item.id} className="rounded-xl border border-white/[0.12] bg-white/[0.05] px-3 py-2 text-xs">
              <span className="font-mono text-zinc-400">{item.key}</span> <DecisionText decision={item} />
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <details className="text-xs text-zinc-400">
          <summary className={`cursor-pointer ${focusRing}`}>{history.length} earlier decision{history.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1.5 space-y-1.5">
            {history.map((item) => (
              <li key={item.id} className="rounded-lg border border-white/[0.08] px-3 py-1.5">
                <span className="font-mono">{item.key}</span> <span className="text-zinc-500">{item.status}</span> <DecisionText decision={item} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

type Panel = "close" | "charter" | "task" | null;

export function TaskBoard({ board, onAction, onOrchestrator, onLocal }: { board: HfmaBoard; onAction: Action; onOrchestrator: (name: string) => Promise<string | null>; onLocal: Local }) {
  // A closed project is final: no more owner actions.
  const open = !board.project.closed_at;
  const [panel, setPanel] = useState<Panel>(null);
  const [finishing, setFinishing] = useState<LocalResult | "busy" | null>(null);
  const tasks = [...board.tasks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.id - b.id);
  const conflicts = (board.decisions ?? []).filter((item) => item.status === "conflict").length;
  // What only yeebyor can resolve: blocked tasks, stale claims, decision conflicts, and a main that moved outside integrate.
  const waiting = board.tasks.filter((task) => task.status === "BLOCKED" || task.stale).length + conflicts + (board.project.inconsistent ? 1 : 0);
  const done = board.tasks.filter((task) => task.status === "DONE").length;
  const pending = board.tasks.filter((task) => task.status !== "DONE" && task.status !== "CANCELLED").length;
  const toggle = (next: Panel) => setPanel((current) => current === next ? null : next);
  const headerButton = (target: Panel, label: string) => (
    <button type="button" onClick={() => toggle(target)} aria-expanded={panel === target}
      className={`underline decoration-white/30 underline-offset-2 hover:text-white ${panel === target ? "text-white" : ""} ${focusRing}`}>
      {label}
    </button>
  );

  return (
    <div className="chat-scroll flex-1 overflow-y-auto pr-1 pt-2" aria-label="Task board">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span>Charter v{board.charter_version}</span>
        {board.orchestrator && (open
          ? <OrchestratorControl current={board.orchestrator} onChange={onOrchestrator} />
          : <span>orchestrator {board.orchestrator}</span>)}
        <span className="tabular-nums">{done} done, {pending} open</span>
        {board.project.main_hash && (
          <span className="flex items-center gap-1 font-mono text-[11px]">
            main <GitCommitHorizontal className="h-3 w-3" aria-hidden="true" />{short(board.project.main_hash)}
          </span>
        )}
        {board.project.closed_at && <span className="flex items-center gap-1 text-emerald-200"><Lock className="h-3 w-3" aria-hidden="true" />closed</span>}
      </div>
      {open && (
        <div role="group" aria-label="Project actions" className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
          {headerButton("task", "New task")}
          {headerButton("charter", "Edit charter")}
          {board.project.main_hash && headerButton("close", "Close project")}
        </div>
      )}
      {open && !board.project.main_hash && (
        // The charter exists but the repo step did not finish (for example git failed): run it again.
        <div role="status" className="mb-3 rounded-xl border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          <p>Setup did not finish: the project folder and worktrees are not ready yet.</p>
          <button type="button" disabled={finishing === "busy"} className={`${smallButton} mt-2`}
            onClick={async () => { setFinishing("busy"); setFinishing(await onLocal({ action: "setup", room: board.room })); }}>
            {finishing === "busy" ? "Setting up..." : "Finish setup"}
          </button>
          {finishing && finishing !== "busy" && finishing.error && <p role="alert" className="mt-1.5 text-red-200">{finishing.error}</p>}
        </div>
      )}
      {open && panel === "close" && <ClosePanel board={board} onLocal={onLocal} onDone={() => setPanel(null)} />}
      {open && panel === "charter" && <CharterEditor board={board} onAction={onAction} onLocal={onLocal} onDone={() => setPanel(null)} />}
      {open && panel === "task" && <NewTask board={board} onAction={onAction} onDone={() => setPanel(null)} />}
      {waiting > 0 && (
        <div role="status" className="mb-3 rounded-xl border border-red-300/30 bg-red-500/15 px-3 py-2 text-xs text-red-100">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {waiting} waiting for you.
              {conflicts > 0 && ` ${conflicts} decision conflict${conflicts === 1 ? "" : "s"} below.`}
              {board.project.inconsistent && " main changed outside integrate. Check the project folder, then accept the current main."}
            </span>
          </p>
          {open && board.project.inconsistent && <AcceptMain room={board.room} onLocal={onLocal} />}
        </div>
      )}
      {tasks.length ? (
        <ul className="space-y-2">{tasks.map((task) => <TaskRow key={task.id} task={task} onAction={open ? onAction : undefined} />)}</ul>
      ) : (
        <p className="text-sm text-zinc-400">No tasks yet. The orchestrator creates them, or add one with New task.</p>
      )}
      <Decisions board={board} onAction={onAction} open={open} />
    </div>
  );
}
