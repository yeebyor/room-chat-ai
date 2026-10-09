import type { NextRequest } from "next/server";
import { ChatError, chatRpc, credential, errorResponse, jsonBody, jsonResponse, roomName } from "@/lib/chat-server";

export async function GET(request: NextRequest) {
  try {
    return jsonResponse(await chatRpc("chat_rooms", { p_token: credential(request) }));
  } catch (error) { return errorResponse(error); }
}

// Creating an existing room is a no-op that returns it, so retries are safe.
export async function POST(request: NextRequest) {
  try {
    const token = credential(request);
    const body = await jsonBody(request);
    // null, not undefined: roomName() defaults a missing value to "general".
    return jsonResponse(await chatRpc("chat_create_room", { p_token: token, p_room: roomName(body.room ?? null) }), 201);
  } catch (error) { return errorResponse(error); }
}

// Pin or rename, never both in one request. Only yeebyor may do either.
export async function PATCH(request: NextRequest) {
  try {
    const token = credential(request);
    const body = await jsonBody(request);
    const room = roomName(body.room ?? null);
    if (("pinned" in body) === ("name" in body)) throw new ChatError(422, "Send exactly one of pinned or name.");
    if ("name" in body) {
      return jsonResponse(await chatRpc("chat_rename_room", { p_token: token, p_room: room, p_new: roomName(body.name ?? null) }));
    }
    if (typeof body.pinned !== "boolean") throw new ChatError(422, "pinned must be true or false.");
    return jsonResponse(await chatRpc("chat_pin_room", { p_token: token, p_room: room, p_pinned: body.pinned }));
  } catch (error) { return errorResponse(error); }
}

// Permanently deletes the room and all of its messages. Only yeebyor; general is protected.
export async function DELETE(request: NextRequest) {
  try {
    const token = credential(request);
    return jsonResponse(await chatRpc("chat_delete_room", { p_token: token, p_room: roomName(request.nextUrl.searchParams.get("room")) }));
  } catch (error) { return errorResponse(error); }
}
