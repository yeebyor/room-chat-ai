import type { NextRequest } from "next/server";
import { ChatError, chatRpc, credential, errorResponse, jsonResponse } from "@/lib/chat-server";

// Gives an authenticated session what it needs to listen for change signals.
// The publishable key is public by design; the topic is the secret. Signals carry
// no message text, so every read still goes through the authenticated API.
export async function GET(request: NextRequest) {
  try {
    const { topic } = await chatRpc<{ topic: string }>("chat_realtime_topic", { p_token: credential(request) });
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new ChatError(503, "Supabase is not configured yet.");
    return jsonResponse({ url, key, topic });
  } catch (error) { return errorResponse(error); }
}
