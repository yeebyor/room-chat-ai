"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { Agent, LocalResult } from "@/lib/chat-types";

// Turns a room into an HFMA project without the terminal: writes the charter, makes
// WORK/<room> its own git repo with one worktree per chosen agent, and records main.
// The server does the git part (src/app/api/hfma/local). Every chosen agent may edit
// every file ("**"); a charter with per-team paths or its own test command still goes
// through the CLI.
//
// The owner never types a test command. Every project from this form is tested with
// `node check.mjs` (Node is always there, since the CLI needs it): the agents' first
// task writes check.mjs to run the project's own tests. The AUTO criterion runs it on
// main at close; the owner's C1, C2, ... are judged by the owner.
const AGENTS: Agent[] = ["Claude", "GPT", "Gemini"];
export const CHECK = "node check.mjs";
// Appended to the goal of every project with the check.mjs convention; the charter
// editor strips it for editing and puts it back on save.
export const CHECK_RULE ="HFMA rule: the first task creates check.mjs in the project root, a Node script that runs every project test "
  + "(for example pytest or npm test, including installing the dependencies they need) and exits with code 0 only when all of them pass. "
  + `The CLI runs ${CHECK} on every submit, verify, integrate and close.`;
const focusRing = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40";
const field = "w-full rounded-lg border border-white/15 bg-white/[0.08] px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-white/35 disabled:opacity-60";
const label = "mb-1.5 block text-xs font-medium tracking-wide text-zinc-300";
const smallButton = `rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-white/[0.14] hover:text-white disabled:opacity-50 ${focusRing}`;

export function ProjectSetup({ room, onSetup }: { room: string; onSetup: (body: Record<string, unknown>) => Promise<LocalResult> }) {
  const [goal, setGoal] = useState("");
  const [agents, setAgents] = useState<Agent[]>(AGENTS);
  const [orchestrator, setOrchestrator] = useState<Agent>("Claude");
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = (agent: Agent) => {
    const next = agents.includes(agent) ? agents.filter((item) => item !== agent) : AGENTS.filter((item) => item === agent || agents.includes(item));
    setAgents(next);
    if (!next.includes(orchestrator) && next.length) setOrchestrator(next[0]);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim()) { setError("Describe the project goal."); return; }
    if (agents.length < 2) { setError("Choose at least two agents: work is always reviewed by another team."); return; }
    setBusy(true);
    setError("");
    const result = await onSetup({
      action: "setup", room,
      charter: {
        goal: `${goal.trim()}\n\n${CHECK_RULE}`, orchestrator, test_command: CHECK,
        criteria: [
          { id: "AUTO", text: `All automated checks (${CHECK}) pass on main.`, check: "command", command: CHECK },
          ...criteria.map((text) => text.trim()).filter(Boolean).map((text, i) => ({ id: `C${i + 1}`, text, check: "owner" })),
        ],
        ownership: Object.fromEntries(agents.map((agent) => [agent, ["**"]])),
      },
    });
    setBusy(false);
    if (result.error) setError(result.error);
  };

  return (
    <form onSubmit={submit} className="chat-scroll flex-1 space-y-4 overflow-y-auto pr-1 pt-2" aria-label="Set up project">
      <div>
        <h2 className="text-base font-medium text-white">Set up project</h2>
        <p className="mt-1 text-xs text-zinc-400">
          Creates <span className="font-mono text-zinc-300">WORK/{room}</span> as its own repo with one worktree per agent. The charter can only be changed by you.
        </p>
      </div>

      <div>
        <label htmlFor="setup-goal" className={label}>Goal</label>
        <textarea id="setup-goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} maxLength={1400} disabled={busy}
          placeholder="What should the agents build, and what must it include?" className={`${field} resize-y`} />
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
          <label htmlFor="setup-orchestrator" className={label}>Orchestrator</label>
          <select id="setup-orchestrator" value={orchestrator} onChange={(event) => setOrchestrator(event.target.value as Agent)} disabled={busy} className={field}>
            {agents.map((agent) => <option key={agent} value={agent} className="bg-zinc-900">{agent}</option>)}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className={label}>Success criteria</legend>
        <p className="mb-2 text-xs text-zinc-400">You judge these when closing. The agents&apos; own tests always run automatically too.</p>
        <ul className="space-y-1.5">
          {criteria.map((text, index) => (
            <li key={index} className="flex items-center gap-1.5">
              <span className="w-6 shrink-0 text-xs tabular-nums text-zinc-500">C{index + 1}</span>
              <input value={text} onChange={(event) => setCriteria(criteria.map((item, i) => i === index ? event.target.value : item))}
                maxLength={2000} disabled={busy} placeholder={index === 0 ? "e.g. The report is easy for me to understand" : ""}
                aria-label={`Criterion C${index + 1}`} className={`${field} py-1.5`} />
              <button type="button" onClick={() => setCriteria(criteria.filter((_, i) => i !== index))} disabled={busy || criteria.length === 1}
                aria-label={`Remove criterion C${index + 1}`} className={`shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-30 ${focusRing}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => setCriteria([...criteria, ""])} disabled={busy || criteria.length >= 12}
          className={`${smallButton} mt-2 flex items-center gap-1`}>
          <Plus className="h-3 w-3" /> Add criterion
        </button>
      </fieldset>

      {error && <p role="alert" className="text-xs text-red-200">{error}</p>}
      <button type="submit" disabled={busy}
        className={`flex w-full items-center justify-center gap-2 rounded-xl border border-white/25 bg-white/[0.14] px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/[0.2] disabled:opacity-60 ${focusRing}`}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? "Setting up..." : "Set up project"}
      </button>
    </form>
  );
}
