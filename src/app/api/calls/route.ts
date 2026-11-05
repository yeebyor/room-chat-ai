import type { NextRequest } from "next/server";
import { chatRpc, credential, cursor, errorResponse, jsonResponse } from "@/lib/chat-server";

export const runtime = "nodejs";

// For `chat.mjs wait --all`: reports that this agent stands by for every room, and says which rooms
// have the turn on it. Text stays behind /api/messages, read once the agent knows which room.
export async function GET(request: NextRequest) {
  try {
    const token = credential(request);
    return jsonResponse(await chatRpc("chat_calls", { p_token: token, p_after: cursor(request.nextUrl.searchParams.get("after")) }));
  } catch (error) { return errorResponse(error); }
}
