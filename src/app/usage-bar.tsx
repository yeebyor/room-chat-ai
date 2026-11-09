"use client";

import { useEffect, useState } from "react";
import type { Turn } from "@/lib/chat-types";

// Who is standing by, and the tokens each agent's session has used (the owner guide, "Seeing what
// the agents use"). The numbers are read from each tool's own log on this computer
// (src/app/api/usage/route.ts), and a log does not say which room a request was for: one session
// answers calls in any room, so its number covers all of them. A small sidebar at the right of the
// window shows this; below the width where it fits, a strip in the middle of the title bar does.
// gone: the agent's sleeping wait was killed, so its CLI was closed; the room may say otherwise for 90 seconds.
export type UsageRow = { agent: string; tool: string; status: "working" | "active" | "listening" | "idle"; gone?: boolean; from_start: boolean; input: number; cached: number; output: number };

const TOOL = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" } as Record<string, string>;
const STATUS = { working: "working", active: "in the room", listening: "standing by", idle: "not running" } as const;
const AGENTS = ["Claude", "GPT", "Gemini"];
const REFRESH_MS = 3_000;

// What each agent is doing now: the room's turn says who is here or standing by, the log who is working,
// and a killed wait who has gone.
function agentStates(turn: Turn | null, rows: UsageRow[]) {
  return AGENTS.map((agent) => {
    const row = rows.find((item) => item.agent === agent);
    const status: UsageRow["status"] = row?.gone ? "idle" : row?.status === "working" ? "working"
      : turn?.present.includes(agent as Turn["present"][number]) ? "active"
        : turn?.listening.includes(agent as Turn["listening"][number]) ? "listening" : "idle";
    return { agent, status };
  });
}

const short = (value: number) => value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}M`;
const full = (value: number) => value.toLocaleString("en-GB");
const dotColor = (status: UsageRow["status"]) => status === "working" ? "bg-emerald-400" : status === "idle" ? "bg-white/15" : "bg-white/35";
const detail = (row: UsageRow) =>
  `${row.agent} (${TOOL[row.tool] ?? row.tool}), ${STATUS[row.status]}\nWhole session, also its work in other rooms, counted from ${row.from_start ? "the start of the session (so starting up is included)" : "when it joined this room"}:\nnew input ${full(row.input)}, output ${full(row.output)}\nread again from cache ${full(row.cached)}`;

export function useUsage(room: string): UsageRow[] {
  // Kept with the room it belongs to, so switching rooms never shows the previous room's numbers.
  const [state, setState] = useState<{ room: string; rows: UsageRow[] }>({ room, rows: [] });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(`/api/usage?room=${encodeURIComponent(room)}`, { cache: "no-store" });
        const data = response.ok ? await response.json() : null;
        if (alive) setState({ room, rows: Array.isArray(data?.agents) ? data.agents : [] });
      } catch { if (alive) setState({ room, rows: [] }); }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [room]);

  return state.room === room ? state.rows : [];
}

// The strip in the middle of the title bar, for windows too narrow for the sidebar.
export function UsageStrip({ rows, turn }: { rows: UsageRow[]; turn: Turn | null }) {
  const shown = agentStates(turn, rows).filter(({ agent, status }) => status !== "idle" || rows.some((row) => row.agent === agent));
  if (!shown.length) return null;
  return (
    <ul aria-label="Agents and the tokens of their sessions" className="pointer-events-none absolute left-1/2 top-0 hidden h-full -translate-x-1/2 items-center gap-4 font-mono text-[11px] text-white/50 sm:flex lg:hidden">
      {shown.map(({ agent, status }) => {
        const row = rows.find((item) => item.agent === agent);
        return (
          <li key={agent} className={`pointer-events-auto flex items-center gap-1.5 whitespace-nowrap ${status === "idle" ? "opacity-50" : ""}`} title={row ? detail(row) : `${agent}, ${STATUS[status]}`}>
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dotColor(status)}`} />
            <span>{agent}</span>
            {row && <span className="tabular-nums text-white/80">{short(row.input + row.output)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

// The small sidebar at the right of the window, as tall as the room list at the left.
export function UsagePanel({ rows, turn }: { rows: UsageRow[]; turn: Turn | null }) {
  return (
    <aside aria-label="Agents and token usage" className="relative z-10 hidden shrink-0 flex-col border-l border-white/15 lg:flex lg:w-44">
      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto p-3 pt-5">
        <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">Agents</p>
        <ul className="mb-4 space-y-1 px-1">
          {agentStates(turn, rows).map(({ agent, status }) => (
            <li key={agent} className={`flex items-center gap-1.5 text-xs ${status === "idle" ? "text-zinc-500" : "text-zinc-200"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor(status)}`} />
              <span className="min-w-0 flex-1 truncate">{agent}</span>
              <span className="shrink-0 text-[11px] text-zinc-500">{STATUS[status]}</span>
            </li>
          ))}
        </ul>
        <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">Session tokens</p>
        {rows.length ? (
          <ul className="space-y-1.5">
            {rows.map((row) => {
              const total = row.input + row.output;
              return (
                <li key={row.agent} title={detail(row)} className={`rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 ${row.status === "idle" ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-1.5 text-sm text-zinc-200">
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor(row.status)}`} />
                    <span className="min-w-0 flex-1 truncate">{row.agent}</span>
                    <span className="font-mono text-xs tabular-nums text-white/80">{short(total)}</span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] leading-snug text-white/45">in {short(row.input)} · out {short(row.output)}</p>
                  <p className="font-mono text-[11px] leading-snug text-white/30">cache {short(row.cached)}</p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-1 text-xs leading-relaxed text-zinc-500">No agent has taken part in this room yet.</p>
        )}
      </div>
    </aside>
  );
}
