import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { NextRequest } from "next/server";
import { ChatError, chatRpc, credential, errorResponse, jsonBody, jsonResponse, roomName, tokenMatches, userToken } from "@/lib/chat-server";
import { checkedRun, commitInfo, dirtyFiles, environment, git, isEmptyFolder, isHfmaRepo, scratch, setupRepo } from "@/lib/hfma-local.mjs";

// Owner actions that need git on this machine (see HFMA.md): set up a project, accept
// the current main, and close a project after running its command criteria on main.
// Guards: yeebyor only, a server running on this machine only, project folders only
// inside WORK, and an existing folder only when it is empty or a repo HFMA created.
// Agents never reach this route; scripts/hfma.mjs setup|main-set|close calls it as yeebyor.

type Charter = { project_path: string; orchestrator: string; criteria: { id: string; check: string; command?: string }[]; ownership: Record<string, string[]> };
type CharterInfo = { version: number; charter: Charter; project: { main_hash: string | null; inconsistent: boolean | null; closed_at: string | null } };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// WORK is the folder that holds room-chat-ai; the server runs from room-chat-ai.
const workRoot = () => resolve(process.env.HFMA_WORK_ROOT ?? join(process.cwd(), ".."));

function insideWork(path: string): string {
  const absolute = resolve(path);
  const rel = relative(workRoot(), absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ChatError(422, "The project folder must be inside the WORK folder.");
  return absolute;
}

async function hfma<T>(token: string, op: string, args: Record<string, unknown>): Promise<T> {
  return chatRpc<T>("chat_hfma", { p_token: token, p_op: op, p_args: args });
}

async function charterOf(token: string, room: string): Promise<CharterInfo | null> {
  try { return await hfma<CharterInfo>(token, "charter_get", { room }); }
  catch (error) { if (error instanceof ChatError && error.status === 404) return null; throw error; }
}

export async function POST(request: NextRequest) {
  try {
    const token = credential(request);
    if (!tokenMatches(token, userToken())) throw new ChatError(403, "Only yeebyor can do this.");
    if (!LOOPBACK.has(request.nextUrl.hostname)) throw new ChatError(403, "This action only works while the server runs on this computer.");
    const body = await jsonBody(request);
    const room = roomName(body.room ?? null);

    if (body.action === "setup") {
      // A charter from the form when the room has none yet; then repo, worktrees, and main.
      let info = await charterOf(token, room);
      if (!info) {
        if (room === "general") throw new ChatError(422, "The general room stays a chat room, not a project.");
        if (!body.charter || typeof body.charter !== "object" || Array.isArray(body.charter)) throw new ChatError(422, "Fill in the project charter first.");
        const folder = join(workRoot(), room);
        if (existsSync(folder) && !isEmptyFolder(folder) && !isHfmaRepo(folder)) {
          throw new ChatError(409, `WORK/${room} already contains files. Use another room name or empty that folder.`);
        }
        await hfma(token, "charter_set", { room, charter: { ...body.charter, project_path: folder.replaceAll("\\", "/") } });
        info = (await charterOf(token, room))!;
      }
      const project = insideWork(info.charter.project_path);
      if (existsSync(project) && !isEmptyFolder(project) && !isHfmaRepo(project)) {
        throw new ChatError(409, "The project folder already contains files or another repo; HFMA leaves it untouched.");
      }
      mkdirSync(project, { recursive: true });
      const main = setupRepo(project, "yeebyor", Object.keys(info.charter.ownership));
      // Never overwrite a recorded main: that would hide a main changed outside integrate.
      if (!info.project.main_hash) await hfma(token, "main_set", { room, main_hash: main, reason: "Set up project" });
      return jsonResponse({ room, version: info.version, project_path: project, main_hash: info.project.main_hash ?? main });
    }

    const info = await charterOf(token, room);
    if (!info) throw new ChatError(404, "This room has no charter yet.");
    const project = insideWork(info.charter.project_path);

    if (body.action === "record") {
      // The whole HFMA record plus what git knows about every commit it mentions.
      const record = await chatRpc<Record<string, unknown[]> & { project: { main_hash: string | null } | null }>(
        "chat_hfma_record", { p_token: token, p_room: room });
      const hashes = new Set<string>();
      const add = (value: unknown) => { if (typeof value === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)) hashes.add(value); };
      add(record.project?.main_hash);
      for (const event of record.events as { commit?: string }[]) add(event.commit);
      for (const task of record.tasks as { candidate?: string; approved_hash?: string; merge_hash?: string }[]) {
        add(task.candidate); add(task.approved_hash); add(task.merge_hash);
      }
      for (const item of record.evidence as { commit?: string }[]) add(item.commit);
      // The folder may have been removed by hand after the room was used; the record still exports.
      const readable = existsSync(join(project, ".git"));
      const commits = readable ? Object.fromEntries([...hashes].map((hash) => [hash, commitInfo(project, hash)])) : {};
      return jsonResponse({ record, commits, git: readable });
    }

    if (body.action === "main_set") {
      if (typeof body.reason !== "string" || !body.reason.trim()) throw new ChatError(422, "Write why you accept the current main.");
      const dirty = dirtyFiles(project);
      if (dirty.length) throw new ChatError(409, `The project folder has uncommitted changes: ${dirty.join(", ")}. Undo them first; only integrate may change that folder.`);
      return jsonResponse(await hfma(token, "main_set", { room, main_hash: git(project, "rev-parse", "main"), reason: body.reason.trim() }));
    }

    if (body.action === "close") {
      const main = git(project, "rev-parse", "main");
      if (!info.project.main_hash) throw new ChatError(409, "The project is not set up yet.");
      const ownerCriteria: string[] = Array.isArray(body.owner_criteria) ? body.owner_criteria.filter((id): id is string => typeof id === "string") : [];
      // Cheap checks first, so the owner is not kept waiting for test runs that cannot lead to a close.
      const board = await hfma<{ tasks: { status: string }[]; decisions: { key: string; status: string }[] }>(token, "board", { room });
      const open = board.tasks.filter((task) => !["DONE", "CANCELLED"].includes(task.status)).length;
      if (open) throw new ChatError(409, `${open} task${open === 1 ? " is" : "s are"} not DONE or CANCELLED yet.`);
      const conflicts = board.decisions.filter((item) => item.status === "conflict").map((item) => `"${item.key}"`);
      if (conflicts.length) throw new ChatError(409, `Resolve the decision conflict on ${conflicts.join(", ")} first.`);
      const unconfirmed = info.charter.criteria.filter((item) => item.check === "owner" && !ownerCriteria.includes(item.id)).map((item) => item.id);
      if (unconfirmed.length) throw new ChatError(422, `Confirm ${unconfirmed.join(", ")} first.`);
      const dirty = dirtyFiles(project);
      const report = await hfma<{ consistent: boolean }>(token, "main_report", { room, main_hash: main, ...(dirty.length ? { dirty: dirty.join(", ").slice(0, 2000) } : {}) });
      if (dirty.length) throw new ChatError(409, `The project folder has uncommitted changes: ${dirty.join(", ")}. Undo them, then accept the current main before closing.`);
      if (!report.consistent) throw new ChatError(409, "main changed outside integrate. Check it and accept the current main before closing.");
      // Every command criterion runs on main now, recorded as close evidence.
      const results = [];
      for (const criterion of info.charter.criteria.filter((item) => item.check === "command")) {
        const result = await checkedRun(scratch(project, main, "yeebyor"), criterion.command!);
        await hfma(token, "evidence_add", {
          room, kind: "close", criterion: criterion.id, commit: main, command: criterion.command, ...result, env: environment(),
        });
        results.push({ id: criterion.id, passed: result.exit_code === 0 && !result.timed_out, ...result });
      }
      const failed = results.filter((item) => !item.passed).map((item) => item.id);
      if (failed.length) {
        return jsonResponse({ room, closed: false, error: `${failed.join(", ")} did not pass on main; see the output below.`, results }, 409);
      }
      // The database checks the same rules again; this only fails if something changed meanwhile.
      try {
        const closed = await hfma<Record<string, unknown>>(token, "project_close", { room, owner_criteria: ownerCriteria });
        return jsonResponse({ ...closed, results });
      } catch (error) {
        if (!(error instanceof ChatError)) throw error;
        // Not closed: say why, with each criterion's run, so the owner sees what failed.
        return jsonResponse({ room, closed: false, error: error.message, results }, error.status);
      }
    }
    throw new ChatError(422, "action must be setup, main_set, close, or record.");
  } catch (error) { return errorResponse(error); }
}
