"use client";

import { useEffect, useState } from "react";

// Tokens each agent used in this room since it joined, in the middle of the window's title bar.
// The numbers are read from each tool's own log on this computer (src/app/api/usage/route.ts),
// so the bar stays empty when the server does not run here or no agent has joined the room.
type Row = { agent: string; tool: string; status: "working" | "active" | "listening" | "idle"; input: number; cached: number; output: number };

const TOOL = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" } as Record<string, string>;
const STATUS = { working: "working", active: "in the room", listening: "standing by", idle: "not running" } as const;
const REFRESH_MS = 10_000;
// A wake after a long idle re-reads the whole conversation, so a large total means every further
// wake is expensive too. The number turns amber at WARN and red at HIGH (new input plus output).
const WARN = 200_000;
const HIGH = 400_000;

const short = (value: number) => value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : `${(value / 1_000_000).toFixed(1)}M`;
const full = (value: number) => value.toLocaleString("en-GB");

export function UsageBar({ room }: { room: string }) {
  // Kept with the room it belongs to, so switching rooms never shows the previous room's numbers.
  const [state, setState] = useState<{ room: string; rows: Row[] }>({ room, rows: [] });
  const rows = state.room === room ? state.rows : [];

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

  if (!rows.length) return null;
  return (
    <ul aria-label="Tokens each agent used in this room in total" className="pointer-events-none absolute left-1/2 top-0 hidden h-full -translate-x-1/2 items-center gap-4 font-mono text-[11px] text-white/50 sm:flex">
      {rows.map((row) => {
        const total = row.input + row.output;
        const level = total >= HIGH ? "high" : total >= WARN ? "warn" : "ok";
        return (
        <li
          key={row.agent}
          className={`pointer-events-auto flex items-center gap-1.5 whitespace-nowrap ${row.status === "idle" ? "opacity-50" : ""}`}
          title={`${row.agent} (${TOOL[row.tool] ?? row.tool}), ${STATUS[row.status]}\nTotal in this room (your messages, project work and its replies):\nnew input ${full(row.input)}, output ${full(row.output)}\nread again from cache ${full(row.cached)}${level === "ok" ? "" : "\nLarge: every wake after a long idle re-reads the whole conversation. Consider a fresh session."}`}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${row.status === "working" ? "bg-emerald-400" : row.status === "idle" ? "bg-white/15" : "bg-white/35"}`} />
          <span>{row.agent}</span>
          <span className={`tabular-nums ${level === "high" ? "text-red-400" : level === "warn" ? "text-amber-300" : "text-white/75"}`}>{short(total)}</span>
        </li>
        );
      })}
    </ul>
  );
}
