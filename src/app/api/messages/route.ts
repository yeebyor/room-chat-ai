import type { NextRequest } from "next/server";
import type { ChatMessage, MessageList } from "@/lib/chat-types";
import { ChatError, chatRpc, credential, cursor, errorResponse, jsonBody, jsonResponse, roomName } from "@/lib/chat-server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const token = credential(request);
    const params = request.nextUrl.searchParams;
    const room = roomName(params.get("room") ?? "general");
    const limitValue = params.get("limit") ?? "100";
    if (!/^\d{1,3}$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 200) {
      throw new ChatError(422, "limit must be between 1 and 200.");
    }
    const after = cursor(params.get("after_id"));
    const before = cursor(params.get("before_id"));
    if ((after !== null && before !== null) || (before !== null && BigInt(before) < BigInt(1))) {
      throw new ChatError(422, "Use only one cursor: after_id or before_id.");
    }
    // Agents running `wait` report presence so the draw skips agents that stopped;
    // `left` removes an agent from the draw at once.
    const presence = params.get("presence");
    if (presence !== null && presence !== "active" && presence !== "listening" && presence !== "left") {
      throw new ChatError(422, "presence must be active, listening or left.");
    }
    return jsonResponse(await chatRpc<MessageList>("chat_read", {
      p_token: token, p_room: room, p_limit: Number(limitValue), p_after: after, p_before: before, p_presence: presence,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    const token = credential(request);
    const body = await jsonBody(request);
    if ("sender" in body) throw new ChatError(422, "Sender ditentukan oleh kredensial; jangan mengirim field sender.");
    const room = roomName(body.room ?? "general");
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || Array.from(message).length > 4000) throw new ChatError(422, "A message is required, at most 4000 characters.");
    const clientId = body.client_id;
    if (typeof clientId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId)) {
      throw new ChatError(422, "client_id must be a UUID so retries do not create duplicate messages.");
    }
    const lastSeen = body.last_seen_id ?? null;
    if (lastSeen !== null && typeof lastSeen !== "string") throw new ChatError(422, "last_seen_id must be a message ID string.");
    return jsonResponse(await chatRpc<{ message: ChatMessage }>("chat_send", {
      p_token: token, p_room: room, p_message: message, p_client_id: clientId, p_last_seen: cursor(lastSeen),
    }), 201);
  } catch (error) { return errorResponse(error); }
}
