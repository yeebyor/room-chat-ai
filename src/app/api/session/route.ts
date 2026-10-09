import { NextResponse, type NextRequest } from "next/server";
import { ChatError, SESSION_COOKIE, chatRpc, checkOrigin, errorResponse, jsonBody, localBrowser, tokenMatches, userToken } from "@/lib/chat-server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    checkOrigin(request);
    const body = await jsonBody(request);
    const expected = userToken();
    // Local development opens without a login screen. Production always needs
    // the private owner access token; the page can exchange #access=... for a cookie.
    const existingSession = request.cookies.get(SESSION_COOKIE)?.value;
    const hasSession = existingSession && tokenMatches(existingSession, expected);
    if (!localBrowser(request) && !hasSession && (typeof body.token !== "string" || !tokenMatches(body.token, expected))) {
      throw new ChatError(401, "Open the chat with yeebyor's access link.");
    }
    await chatRpc("chat_read", { p_token: expected, p_room: "general", p_limit: 1 });
    const response = NextResponse.json({ sender: "yeebyor" }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, expected, {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (error) { return errorResponse(error); }
}
