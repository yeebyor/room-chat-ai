"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { Agent, HfmaBoard, LocalResult } from "@/lib/chat-types";
import { CHECK, CHECK_RULE } from "./project-setup";

// Edits the charter as a new version: goal, agents, orchestrator, and the owner's own
// criteria. Everything the form does not show is kept as it is: the test command,
// command criteria such as AUTO, and per-team file paths of agents that stay. An agent
// added here may edit every file ("**") and gets its worktree right after saving.
const AGENTS: Agent[] = ["Claude", "GPT", "Gemini"];
const focusRing = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40";
const field = "w-full rounded-md border border-white/15 bg-white/[0.08] px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-white/35 disabled:opacity-60";
const label = "mb-1.5 block text-xs font-medium tracking-wide text-zinc-300";
const smallButton = `rounded-md border border-white/15 bg-white/[0.06] px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-white/[0.14] hover:text-white disabled:opacity-50 ${focusRing}`;

type Criterion = { id: string; text: string; check: "command" | "owner"; command?: string };
type Charter = { goal: string; orchestrator: Agent; test_command: string; criteria: Criterion[]; ownership: Record<string, string[]>; [key: string]: unknown };
type Act = (op: string, args: Record<string, unknown>) => Promise<string | null>;

const RULE_SUFFIX = `\n\n${CHECK_RULE}`;

export function CharterEditor({ board, onAction, onLocal, onDone }: {
  board: HfmaBoard; onAction: Act; onLocal: (body: Record<string, unknown>) => Promise<LocalResult>; onDone: () => void;
}) {
  const [charter, setCharter] = useState<Charter | null>(null);
  const [goal, setGoal] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [orchestrator, setOrchestrator] = useState<Agent>("Claude");
  const [owned, setOwned] = useState<{ id: string | null; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Read the full current charter: the board only carries part of it.
  useEffect(() => {
    let live = true;
    (async () => {
      const response = await fetch("/api/hfma", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "charter_get", args: { room: board.room } }),
      });
      const data = await response.json();
      if (!live) return;
      if (!response.ok) { setError(data.error || "The charter could not be read."); return; }
      const current = data.charter as Charter;
      setCharter(current);
      setGoal(current.goal.endsWith(RULE_SUFFIX) ? current.goal.slice(0, -RULE_SUFFIX.length) : current.goal);
      setAgents(AGENTS.filter((agent) => agent in current.ownership));
      setOrchestrator(current.orchestrator);
      setOwned(current.criteria.filter((item) => item.check === "owner").map((item) => ({ id: item.id, text: item.text })));
    })().catch(() => { if (live) setError("The charter could not be read."); });
    return () => { live = false; };
  }, [board.room]);

  if (!charter) {
    return <div className="mb-3 rounded-md border border-white/20 bg-white/[0.06] p-3 text-xs text-zinc-300">{error || "Loading the charter..."}</div>;
  }

  const toggle = (agent: Agent) => {
    const next = agents.includes(agent) ? agents.filter((item) => item !== agent) : AGENTS.filter((item) => item === agent || agents.includes(item));
    setAgents(next);
    if (!next.includes(orchestrator) && next.length) setOrchestrator(next[0]);
  };
  const commands = charter.criteria.filter((item) => item.check === "command");

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim()) { setError("The goal cannot be empty."); return; }
    if (agents.length < 2) { setError("Keep at least two agents: work is always reviewed by another team."); return; }
    // A removed agent must not leave work behind that nobody can pick up.
    const stranded = board.tasks.filter((task) => !agents.includes(task.team) && !["DONE", "CANCELLED"].includes(task.status));
    if (stranded.length) { setError(`Reassign or cancel ${stranded.map((task) => `#${task.id}`).join(", ")} before removing ${stranded[0].team}.`); return; }
    // New owner criteria get the next free C number (older charters used K); existing ones keep theirs.
    let next = Math.max(0, ...charter.criteria.map((item) => Number(/^[CK](\d+)$/.exec(item.id)?.[1] ?? 0))) + 1;
    const ownerCriteria = owned.filter((row) => row.text.trim()).map((row) => ({ id: row.id ?? `C${next++}`, text: row.text.trim(), check: "owner" as const }));
    if (!commands.length && !ownerCriteria.length) { setError("Keep at least one criterion."); return; }
    const added = agents.filter((agent) => !(agent in charter.ownership));
    const updated: Charter = {
      ...charter,
      goal: charter.test_command === CHECK ? `${goal.trim()}${RULE_SUFFIX}` : goal.trim(),
      orchestrator,
      criteria: [...commands, ...ownerCriteria],
      ownership: Object.fromEntries(agents.map((agent) => [agent, charter.ownership[agent] ?? ["**"]])),
    };
    setBusy(true);
    setError("");
    const failure = await onAction("charter_set", { room: board.room, charter: updated });
    if (failure) { setBusy(false); setError(failure); return; }
    // A newly added agent needs its worktree; setup is safe to run again.
    if (added.length) {
      const result = await onLocal({ action: "setup", room: board.room });
      if (result.error) { setBusy(false); setError(`Saved, but the worktree for ${added.join(", ")} failed: ${result.error}`); return; }
    }
    setBusy(false);
    onDone();
  };

  return (
    <form onSubmit={save} className="mb-3 space-y-3 rounded-md border border-white/20 bg-white/[0.06] p-3" aria-label="Edit charter">
      <div>
        <p className="text-sm text-white">Edit charter</p>
        <p className="mt-0.5 text-xs text-zinc-400">Saving creates version {(board.charter_version ?? 0) + 1}. Closing always checks the latest version.</p>
      </div>
      <div>
        <label htmlFor="edit-goal" className={label}>Goal</label>
        <textarea id="edit-goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={4} maxLength={1400} disabled={busy} className={`${field} resize-y`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset>
          <legend className={label}>Agents</legend>
          <div className="flex flex-wrap gap-3 pt-1.5">
            {AGENTS.map((agent) => (
              <label key={agent} className="flex items-center gap-1.5 text-sm text-zinc-200">
                <input type="checkbox" checked={agents.includes(agent)} onChange={() => toggle(agent)} disabled={busy} className="accent-white" />
                {agent}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="edit-orchestrator" className={label}>Orchestrator</label>
          <select id="edit-orchestrator" value={orchestrator} onChange={(event) => setOrchestrator(event.target.value as Agent)} disabled={busy} className={field}>
            {agents.map((agent) => <option key={agent} value={agent} className="bg-zinc-900">{agent}</option>)}
          </select>
        </div>
      </div>
      <fieldset>
        <legend className={label}>Success criteria</legend>
        <ul className="space-y-1.5">
          {commands.map((item) => (
            <li key={item.id} className="flex items-start gap-1.5 text-xs text-zinc-400">
              <span className="w-10 shrink-0 tabular-nums text-zinc-500">{item.id}</span>
              <span>{item.text} <span className="font-mono text-[11px]">runs: {item.command}</span> (automatic, kept)</span>
            </li>
          ))}
          {owned.map((row, index) => (
            <li key={row.id ?? `new-${index}`} className="flex items-center gap-1.5">
              <span className="w-10 shrink-0 text-xs tabular-nums text-zinc-500">{row.id ?? "new"}</span>
              <input value={row.text} onChange={(event) => setOwned(owned.map((item, i) => i === index ? { ...item, text: event.target.value } : item))}
                maxLength={2000} disabled={busy} aria-label={`Criterion ${row.id ?? "new"}`} className={`${field} py-1.5`} />
              <button type="button" onClick={() => setOwned(owned.filter((_, i) => i !== index))} disabled={busy}
                aria-label={`Remove criterion ${row.id ?? "new"}`} className={`shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white ${focusRing}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setOwned([...owned, { id: null, text: "" }])} disabled={busy || owned.length >= 12}
          className={`${smallButton} mt-2 flex items-center gap-1`}>
          <Plus className="h-3 w-3" /> Add criterion
        </button>
      </fieldset>
      {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
      <div className="flex gap-1.5">
        <button type="button" onClick={onDone} disabled={busy} className={smallButton}>Cancel</button>
        <button type="submit" disabled={busy} className={`${smallButton} flex items-center gap-1 border-white/30 bg-white/[0.14]`}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}{busy ? "Saving..." : "Save as new version"}
        </button>
      </div>
    </form>
  );
}
