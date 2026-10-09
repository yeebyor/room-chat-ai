import type { NextRequest } from "next/server";
import { chatRpc, credential, errorResponse, jsonResponse } from "@/lib/chat-server";

export async function GET(request: NextRequest) {
  try {
    await chatRpc("chat_read", { p_token: credential(request), p_room: "general", p_limit: 1 });
    return jsonResponse({ status: "ok", database: "connected" });
  } catch (error) { return errorResponse(error); }
}
