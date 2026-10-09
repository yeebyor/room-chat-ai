import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "room_chat_session";

export class ChatError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function userToken(): string {
  const token = process.env.CHAT_USER_TOKEN;
  if (!token) throw new ChatError(503, "Chat access is not configured yet.");
  return token;
}

export function tokenMatches(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function checkOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if ((origin && origin !== request.nextUrl.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ChatError(403, "Requests from another origin are not allowed.");
  }
}

export function credential(request: NextRequest): string {
  checkOrigin(request);
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    if (!match) throw new ChatError(401, "Invalid chat credentials.");
    return match[1];
  }
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session || !tokenMatches(session, userToken())) {
    throw new ChatError(401, "Open the chat with yeebyor's access link.");
  }
  return session;
}

export function localBrowser(request: NextRequest): boolean {
  return process.env.NODE_ENV === "development"
    && ["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname);
}

export function roomName(value: unknown = "general"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(value)) {
    throw new ChatError(422, "Room names are 1 to 50 letters, digits, hyphens or underscores.");
  }
  return value;
}

export function cursor(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) > BigInt("9223372036854775807")) {
    throw new ChatError(422, "Invalid message cursor.");
  }
  return value;
}

export async function jsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ChatError(415, "Use Content-Type application/json.");
  }
  // Bound the streamed body before JSON parsing, including chunked requests.
  const reader = request.body?.getReader();
  if (!reader) throw new ChatError(400, "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) {
      await reader.cancel();
      throw new ChatError(413, "The request body is too large.");
    }
    chunks.push(value);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ChatError(400, "Invalid JSON body."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ChatError(400, "The JSON body must be an object.");
  }
  return body as Record<string, unknown>;
}

export async function chatRpc<T>(name: "chat_read" | "chat_send" | "chat_rooms" | "chat_create_room" | "chat_pin_room" | "chat_rename_room" | "chat_delete_room" | "chat_realtime_topic" | "chat_hfma" | "chat_hfma_record", args: Record<string, unknown>): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new ChatError(503, "Supabase is not configured yet.");
  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new ChatError(503, "Supabase cannot be reached right now. Try again."); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (body?.code === "28000") throw new ChatError(401, "Chat credentials are invalid or revoked.");
    if (body?.code === "22023") throw new ChatError(422, "Invalid room or message.");
    if (body?.code === "23505") throw new ChatError(409, "This request ID was already used for a different message.");
    if (body?.code === "42501") throw new ChatError(403, "Only yeebyor can create or change rooms.");
    if (body?.code === "CROOM") {
      throw new ChatError(409, body.details === "exists"
        ? "That room name is already taken."
        : "An agent is still active in this room. Ask it to leave first or wait 90 seconds.");
    }
    if (body?.code === "P0002") throw new ChatError(404, "Room not found.");
    // HFMA rule violations carry their own message (chat_private.hfma in supabase/schema.sql).
    if (body?.code === "CTASK") {
      const status = { forbidden: 403, missing: 404, invalid: 422 }[body.details as string] ?? 409;
      throw new ChatError(status, body.message);
    }
    if (body?.code === "CTURN") {
      if (body.details === "last_seen") throw new ChatError(422, "Agents must send last_seen_id with the ID of the latest message in this room (0 for an empty room).");
      throw new ChatError(409, body.details === "stopped"
        ? "The conversation was stopped by yeebyor. Wait for a new message from yeebyor."
        : body.details === "stale"
          ? "There are new messages since you last read. Read again and write your reply from the latest context."
          : body.details === "owner"
            ? "Waiting for yeebyor to answer. The turn opens again 100 seconds after yeebyor was called."
          : body.details !== "none"
            ? `It is not your turn. Next turn: ${body.details}. Read again and wait for your turn.`
            : "No agent has the turn yet. Wait until someone is called with @name.");
    }
    throw new ChatError(503, "The chat database cannot be reached right now. Try again.");
  }
  return body as T;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ChatError) return jsonResponse({ error: error.message }, error.status);
  return jsonResponse({ error: "Something went wrong on the chat server." }, 500);
}
