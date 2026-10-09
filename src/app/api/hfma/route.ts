import type { NextRequest } from "next/server";
import { ChatError, chatRpc, credential, errorResponse, jsonBody, jsonResponse } from "@/lib/chat-server";

// One entry point for HFMA (see HFMA.md): { "op": "...", "args": { ... } }.
// The database checks every rule; agents call this through scripts/hfma.mjs.
export async function POST(request: NextRequest) {
  try {
    const token = credential(request);
    const body = await jsonBody(request);
    if (typeof body.op !== "string" || !/^[a-z_]{1,40}$/.test(body.op)) throw new ChatError(422, "Invalid op.");
    const args = body.args ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) throw new ChatError(422, "args must be an object.");
    return jsonResponse(await chatRpc("chat_hfma", { p_token: token, p_op: body.op, p_args: args }));
  } catch (error) { return errorResponse(error); }
}
