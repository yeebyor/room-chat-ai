import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import type { Agent, ChatMessage, MessageList } from "@/lib/chat-types";
import { ChatError, chatRpc, credential, errorResponse, jsonResponse, roomName, tokenMatches, userToken } from "@/lib/chat-server";
import { countFrom, firstInvolved, sessionUsage } from "@/lib/usage.mjs";

export const runtime = "nodejs";

// What each agent has used in this room since it joined, for the title bar. The numbers come
// from the log each tool keeps on this computer (src/lib/usage.mjs): the requests it made from the
// start of its session when it was opened for this room, otherwise from when it joined the room. Only counts are returned, never text.
// yeebyor only, and only while the server runs on this computer.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const AGENTS: Agent[] = ["Claude", "GPT", "Gemini"];
// An agent whose session log changed this recently is working, even if its presence lapsed.
const WORKING_MS = 60_000;

type Joined = { session: string; tool: string; joined: { at: number } };

// chat.mjs writes the record when a session joins a room. A session that was already standing by
// before that existed has a record without it: its tool is found by looking for the session's log,
// and the count starts when the room first involved the agent, so it covers the work done there.
function joinedRecord(agent: Agent, room: string, messages: ChatMessage[]): Joined | null {
  const file = join(tmpdir(), `room-chat-ai-seen-${agent}-${room.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (!record?.session) return null;
    if (record.tool && record.joined?.at) return record;
    for (const tool of ["claude", "codex", "antigravity"]) {
      if (!sessionUsage(tool, record.session, Infinity)) continue;
      const joined = { at: firstInvolved(messages, agent) ?? Date.now() };
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
    const { turn, messages } = await chatRpc<MessageList>("chat_read", { p_token: token, p_room: room, p_limit: 200, p_after: null, p_before: null, p_presence: null });
    const agents = [];
    for (const agent of AGENTS) {
      const record = joinedRecord(agent, room, messages);
      if (!record) continue;
      let used = sessionUsage(record.tool, record.session, record.joined.at);
      if (!used) continue;
      // A session opened for this room counts from its first request, so starting up is included.
      const { from, fromStart } = countFrom(record.joined.at, used.started);
      if (fromStart) used = sessionUsage(record.tool, record.session, from) ?? used;
      const status = turn.present.includes(agent) ? "active" : turn.listening.includes(agent) ? "listening" : null;
      const working = Date.now() - used.at < WORKING_MS;
      // An agent that is no longer running stays in the list as "idle": its total in this room is
      // still what the room cost, and it shows for rooms from before as long as the log exists.
      const { input, cached, output } = used;
      agents.push({ agent, tool: record.tool, status: working ? "working" : (status ?? "idle"), counted_from: from, from_start: fromStart, input, cached, output });
    }
    return jsonResponse({ room, agents });
  } catch (error) { return errorResponse(error); }
}
