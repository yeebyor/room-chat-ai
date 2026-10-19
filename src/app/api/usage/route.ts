import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import type { Agent, MessageList } from "@/lib/chat-types";
import { ChatError, chatRpc, credential, errorResponse, jsonResponse, roomName, tokenMatches, userToken } from "@/lib/chat-server";
import { sessionUsage, usageSince } from "@/lib/usage.mjs";

export const runtime = "nodejs";

// What each agent has used in this room since it joined, for the title bar. The numbers come
// from the log each tool keeps on this computer (src/lib/usage.mjs); chat.mjs wrote when the
// session joined the room and what it had used by then. Only counts are returned, never text.
// yeebyor only, and only while the server runs on this computer.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const AGENTS: Agent[] = ["Claude", "GPT", "Gemini"];
// An agent whose session log changed this recently is working, even if its presence lapsed.
const WORKING_MS = 60_000;

type Joined = { session: string; tool: string; joined: { at: number; usage: { input: number; cached: number; output: number } } };

// chat.mjs writes the record when a session joins a room. A session that was already standing by
// before that existed has a record without it: its tool is found by looking for the session's log,
// and the count starts from now (the first time the app sees it).
function joinedRecord(agent: Agent, room: string): Joined | null {
  const file = join(tmpdir(), `room-chat-ai-seen-${agent}-${room.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (!record?.session) return null;
    if (record.tool && record.joined?.usage) return record;
    for (const tool of ["claude", "codex", "antigravity"]) {
      const usage = sessionUsage(tool, record.session);
      if (!usage) continue;
      const joined = { at: Date.now(), usage: { input: usage.input, cached: usage.cached, output: usage.output } };
      writeFileSync(file, JSON.stringify({ ...record, tool, joined }));
      return { session: record.session, tool, joined };
    }
    return null;
  } catch { return null; }
}

export async function GET(request: NextRequest) {
  try {
    const token = credential(request);
    if (!tokenMatches(token, userToken())) throw new ChatError(403, "Only yeebyor can see this.");
    if (!LOOPBACK.has(request.nextUrl.hostname)) throw new ChatError(403, "Token usage is only available while the server runs on this computer.");
    const room = roomName(request.nextUrl.searchParams.get("room") ?? "general");
    // Presence says who is standing by or working in the room right now (reading it reports none).
    const { turn } = await chatRpc<MessageList>("chat_read", { p_token: token, p_room: room, p_limit: 1, p_after: null, p_before: null, p_presence: null });
    const agents = [];
    for (const agent of AGENTS) {
      const record = joinedRecord(agent, room);
      if (!record) continue;
      const now = sessionUsage(record.tool, record.session);
      if (!now) continue;
      const status = turn.present.includes(agent) ? "active" : turn.listening.includes(agent) ? "listening" : null;
      const working = Date.now() - now.at < WORKING_MS;
      // Shown while it is standing by or working; an agent that left long ago is not "running".
      if (!status && !working) continue;
      const { input, cached, output } = usageSince(now, record.joined.usage);
      agents.push({ agent, tool: record.tool, status: working ? "working" : status, joined_at: record.joined.at, input, cached, output });
    }
    return jsonResponse({ room, agents });
  } catch (error) { return errorResponse(error); }
}
