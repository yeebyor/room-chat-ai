"use client";

import { use, useCallback, useEffect, useId, useRef, useState } from "react";
import { Download, FolderGit2, ListChecks, Loader2, Send } from "lucide-react";
import { RealtimeClient } from "@supabase/realtime-js";
import type { ChatMessage, HfmaBoard, LocalResult, MessageList, Room, RoomList } from "@/lib/chat-types";
import { EXPORT_FORMATS, downloadFile, fetchFullHistory, fileStamp, formatExport, type ExportFormat } from "@/lib/chat-export";
import { formatProjectExport, type ProjectRecord } from "@/lib/project-export";
import { PINNED_ROOM, RoomSidebar } from "./room-sidebar";
import { ProjectSetup } from "./project-setup";
import { TaskBoard } from "./task-board";

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(previous.map((message) => [message.id, message]));
  incoming.forEach((message) => byId.set(message.id, message));
  return [...byId.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

async function fetchRooms(signal?: AbortSignal): Promise<Room[] | null> {
  const response = await fetch("/api/rooms", { cache: "no-store", signal });
  return response.ok ? ((await response.json()) as RoomList).rooms : null;
}

async function hfma<T>(op: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const response = await fetch("/api/hfma", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, args }), signal,
  });
  const data = await response.json();
  return response.ok ? { ok: true, data: data as T } : { ok: false, error: (data.error as string) || "HFMA request failed." };
}

// The HFMA board of a room, with the charter's orchestrator; null when it cannot be read.
// Rooms without a charter have no board.
async function fetchBoard(room: string, signal?: AbortSignal): Promise<HfmaBoard | null> {
  const board = await hfma<HfmaBoard>("board", { room }, signal);
  if (!board.ok) return null;
  if (board.data.charter_version === null) return board.data;
  const charter = await hfma<{ charter: Pick<HfmaBoard, "orchestrator" | "criteria"> & { ownership: Record<string, string[]> } }>("charter_get", { room }, signal);
  if (!charter.ok) return board.data;
  const { orchestrator, criteria, ownership } = charter.data.charter;
  return { ...board.data, orchestrator, criteria, agents: Object.keys(ownership) as HfmaBoard["agents"] };
}

// Owner actions that run git on this machine: set up, accept main, close (src/app/api/hfma/local).
// Close runs the command criteria first, so it can take minutes.
async function localAction(body: Record<string, unknown>): Promise<LocalResult> {
  try {
    const response = await fetch("/api/hfma/local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    return { error: response.ok ? null : (data.error as string) || "The action failed.", results: data.results };
  } catch { return { error: "The server could not be reached." }; }
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

// created_at is UTC from Supabase; render in the viewer's local timezone.
// Messages from an earlier day also get the date.
function MessageTime({ value }: { value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = date.toDateString() === new Date().toDateString();
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString("en-GB")} className="ml-auto shrink-0 text-xs tabular-nums text-zinc-400">
      {today ? timeFormat.format(date) : `${dayFormat.format(date)}, ${timeFormat.format(date)}`}
    </time>
  );
}

function ClaudeIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      className={className}
      fill="#D97757"
    >
      <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
    </svg>
  );
}

function GptIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      fill="#FFFFFF"
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1683a.071.071 0 0 1 .038.052v5.5826a4.5045 4.5045 0 0 1-4.4945 4.4947zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1683a.0757.0757 0 0 1-.071 0l-4.8303-2.7866A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1635a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function GeminiIcon({ className = "h-4 w-4" }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4285f4" />
          <stop offset="35%" stopColor="#ea4335" />
          <stop offset="65%" stopColor="#fbbc05" />
          <stop offset="100%" stopColor="#34a853" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradientId})`} d="M12 1C13.5 7.5 16.5 10.5 23 12C16.5 13.5 13.5 16.5 12 23C10.5 16.5 7.5 13.5 1 12C7.5 10.5 10.5 7.5 12 1Z" />
    </svg>
  );
}

export default function Home({ searchParams }: PageProps<"/">) {
  const requestedRoom = use(searchParams).room;
  const [activeRoom, setActiveRoom] = useState(typeof requestedRoom === "string" && requestedRoom ? requestedRoom : PINNED_ROOM);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [sendError, setSendError] = useState("");
  const [notice, setNotice] = useState("");
  const currentRoom = useRef(activeRoom);
  const wakePoll = useRef<() => void>(() => {});
  const realtimeLive = useRef(false);
  const accessToken = useRef<string | null>(null);
  const sessionReady = useRef(false);
  const messageList = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const pending = useRef<{ text: string; id: string } | null>(null);
  const sendingLock = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportMenu = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<HfmaBoard | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const hasBoard = board?.room === activeRoom && board.charter_version !== null;
  // A room without a charter can become a project; general stays a chat room.
  const canSetup = board?.room === activeRoom && board.charter_version === null && activeRoom !== PINNED_ROOM;
  const projectView = showTasks && (hasBoard || canSetup);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !exportMenu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [menuOpen]);

  const handleExport = async (format: ExportFormat) => {
    setMenuOpen(false);
    setExporting(true);
    setExportError("");
    try {
      const history = await fetchFullHistory(activeRoom);
      // A project room exports the whole record: chat and HFMA events on one timeline, with commits.
      if (hasBoard) {
        const response = await fetch("/api/hfma/local", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "record", room: activeRoom }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(`Project record unavailable: ${(data.error as string) || "the server could not read it"}.`);
        const { content, mime } = formatProjectExport(format, activeRoom, history, data as ProjectRecord);
        downloadFile(`project-${activeRoom}-${fileStamp()}.${format}`, content, mime);
        return;
      }
      if (!history.length) throw new Error("No messages to export yet.");
      const { content, mime } = formatExport(format, activeRoom, history);
      downloadFile(`chat-${activeRoom}-${fileStamp()}.${format}`, content, mime);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    const access = new URLSearchParams(window.location.hash.slice(1)).get("access");
    if (!access) return;
    accessToken.current = access;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  const switchRoom = useCallback((name: string) => {
    if (name === activeRoom) return;
    currentRoom.current = name;
    setActiveRoom(name);
    setMessages([]);
    setReady(false);
    setInputMessage("");
    setLoadError("");
    setSendError("");
    setExportError("");
    setNotice("");
    setBoard(null);
    setShowTasks(false);
    pending.current = null;
    followMessages.current = true;
    window.history.replaceState(null, "", name === PINNED_ROOM ? "/" : `/?room=${encodeURIComponent(name)}`);
  }, [activeRoom]);

  // Both return an error message for the sidebar to show, or null on success.
  const createRoom = async (name: string) => {
    try {
      const response = await fetch("/api/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: name }),
      });
      const data = await response.json();
      if (!response.ok) return (data.error as string) || "Room could not be created.";
      setRooms((previous) => previous.some((item) => item.name === name) ? previous : [...previous, data.room as Room]);
      switchRoom(name);
      return null;
    } catch { return "Room could not be created."; }
  };

  const togglePin = async (name: string, pinned: boolean) => {
    try {
      const response = await fetch("/api/rooms", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: name, pinned }),
      });
      const data = await response.json();
      if (!response.ok) return (data.error as string) || "Pin could not be changed.";
      const list = await fetchRooms();
      if (list) setRooms(list);
      return null;
    } catch { return "Pin could not be changed."; }
  };

  const renameRoom = async (name: string, next: string) => {
    try {
      const response = await fetch("/api/rooms", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: name, name: next }),
      });
      const data = await response.json();
      if (!response.ok) return (data.error as string) || "Room could not be renamed.";
      if (name === activeRoom) {
        // Same messages under a new name: keep them on screen and follow the room.
        currentRoom.current = next;
        setActiveRoom(next);
        window.history.replaceState(null, "", `/?room=${encodeURIComponent(next)}`);
      }
      const list = await fetchRooms();
      if (list) setRooms(list);
      return null;
    } catch { return "Room could not be renamed."; }
  };

  const deleteRoom = async (name: string) => {
    try {
      const response = await fetch(`/api/rooms?room=${encodeURIComponent(name)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) return (data.error as string) || "Room could not be deleted.";
      if (name === activeRoom) switchRoom(PINNED_ROOM);
      const list = await fetchRooms();
      if (list) setRooms(list);
      return null;
    } catch { return "Room could not be deleted."; }
  };

  // Owner actions from the task board. They return an error to show, or null on success;
  // the board then refreshes at once instead of waiting for the realtime signal.
  const taskAction = async (op: string, args: Record<string, unknown>) => {
    try {
      const result = await hfma(op, args);
      if (!result.ok) return result.error;
      wakePoll.current();
      return null;
    } catch { return "The action could not be sent."; }
  };

  // Setup, accepting main, and closing run git on this machine; the board refreshes after.
  const ownerLocal = async (body: Record<string, unknown>) => {
    const result = await localAction(body);
    if (!result.error || result.results) wakePoll.current();
    return result;
  };

  // Handing over the orchestrator role writes the same charter as a new version.
  const changeOrchestrator = async (name: string) => {
    try {
      const current = await hfma<{ charter: Record<string, unknown> }>("charter_get", { room: activeRoom });
      if (!current.ok) return current.error;
      return await taskAction("charter_set", { room: activeRoom, charter: { ...current.data.charter, orchestrator: name } });
    } catch { return "The orchestrator could not be changed."; }
  };

  // Realtime carries signals only ("something changed"); every read still goes through
  // the authenticated API. If it is unavailable the 2 second polling below carries on.
  useEffect(() => {
    let cancelled = false;
    let client: RealtimeClient | undefined;
    (async () => {
      while (!sessionReady.current) {
        if (cancelled) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        const response = await fetch("/api/realtime", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const { url, key, topic } = (await response.json()) as { url: string; key: string; topic: string };
        client = new RealtimeClient(`${url.replace(/^http/, "ws")}/realtime/v1`, { params: { apikey: key } });
        const channel = client.channel(topic, { config: { broadcast: { self: false }, private: false } });
        channel.on("broadcast", { event: "change" }, () => wakePoll.current());
        channel.subscribe((status) => {
          realtimeLive.current = status === "SUBSCRIBED";
          if (status === "SUBSCRIBED") wakePoll.current();
        });
      } catch { /* polling keeps the chat current */ }
    })();
    return () => { cancelled = true; realtimeLive.current = false; void client?.disconnect(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let running = false;
    let wakeAgain = false;
    let refreshRooms = true;
    let lastRoomsAt = 0;
    let seenActive = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastReadId: string | null = null;

    async function poll() {
      running = true;
      wakeAgain = false;
      let boardRequest: Promise<HfmaBoard | null> | null = null;
      try {
        if (!sessionReady.current) {
          const response = await fetch("/api/session", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(accessToken.current ? { token: accessToken.current } : {}), signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "The chat cannot be reached right now.");
          sessionReady.current = true;
        }
        // The room list reloads on a realtime signal or every 10 seconds; a failure there never blocks messages.
        if (refreshRooms || Date.now() - lastRoomsAt > 10000) {
          refreshRooms = false;
          const list = await fetchRooms(controller.signal);
          if (list && !stopped) {
            lastRoomsAt = Date.now();
            const listed = list.some((item) => item.name === activeRoom);
            // Seen on the server and now gone: renamed or deleted elsewhere. Ignored while this tab is switching itself.
            if (seenActive && !listed && currentRoom.current === activeRoom) {
              setRooms(list);
              switchRoom(PINNED_ROOM);
              setNotice(`Room "${activeRoom}" was renamed or deleted.`);
              return;
            }
            seenActive ||= listed;
            setRooms(list);
          }
          // Same cadence for the task board (realtime signals from tasks and charters land here too),
          // fetched alongside the messages so it never delays them.
          boardRequest = fetchBoard(activeRoom, controller.signal).catch(() => null);
        }
        const params = new URLSearchParams({ room: activeRoom, limit: "100" });
        if (lastReadId) params.set("after_id", lastReadId);
        const response = await fetch(`/api/messages?${params}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 401) sessionReady.current = false;
          throw new Error(data.error || "The conversation failed to load.");
        }
        if (stopped) return;
        const result = data as MessageList;
        setMessages((previous) => mergeMessages(previous, result.messages));
        // Only GET advances the cursor. A POST response may arrive ahead of
        // another participant's message and must not cause it to be skipped.
        if (result.messages.length) lastReadId = result.messages[result.messages.length - 1].id;
        setLoadError("");
        setReady(true);
        const nextBoard = await boardRequest;
        if (nextBoard && !stopped) setBoard(nextBoard);
      } catch (error) {
        if (!stopped) setLoadError(error instanceof Error ? error.message : "The conversation failed to load.");
      } finally {
        running = false;
        // With realtime connected, polling only backs it up.
        if (!stopped) timer = setTimeout(poll, wakeAgain ? 0 : realtimeLive.current ? 15000 : 2000);
      }
    }
    wakePoll.current = () => {
      refreshRooms = true;
      if (running) { wakeAgain = true; return; }
      clearTimeout(timer);
      void poll();
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); wakePoll.current = () => {}; };
  }, [activeRoom, switchRoom]);

  useEffect(() => {
    if (followMessages.current && messageList.current) {
      messageList.current.scrollTop = messageList.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputMessage.trim();
    if (!text || !ready || sendingLock.current) return;
    sendingLock.current = true;
    setSending(true);
    setSendError("");
    if (pending.current?.text !== text) pending.current = { text, id: crypto.randomUUID() };
    try {
      const response = await fetch("/api/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: activeRoom, message: text, client_id: pending.current.id }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The message could not be sent.");
      followMessages.current = true;
      // The reply may land after yeebyor switched rooms; only show it in its own room.
      if ((data.message as ChatMessage).room === currentRoom.current) {
        setMessages((previous) => mergeMessages(previous, [data.message as ChatMessage]));
      }
      setInputMessage((current) => current.trim() === text ? "" : current);
      pending.current = null;
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "The message could not be sent. Try again.");
    } finally {
      sendingLock.current = false;
      setSending(false);
    }
  };

  return (
    <main
      className="relative flex min-h-screen w-full items-center justify-start p-6 sm:p-10 md:pl-8 lg:pl-10 xl:pl-12 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/background.png')" }}
    >
      {/* Liquid Glass Frame (Subtle & Elegant): room sidebar and chat share one frame */}
      <div className="relative flex flex-col md:flex-row w-full sm:w-[480px] md:w-[692px] h-[86vh] max-h-[860px] rounded-2xl overflow-hidden border border-white/[0.16] bg-white/[0.06] backdrop-blur-2xl shadow-[0_25px_60px_rgba(0,0,0,0.6),inset_0_1px_1.5px_rgba(255,255,255,0.35),inset_0_-1px_1px_rgba(255,255,255,0.1)] transition-all duration-300">
        
        {/* Soft Glass Bevel Highlight */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white/[0.09] to-transparent rounded-t-2xl" />

        <RoomSidebar activeRoom={activeRoom} rooms={rooms} onSelect={switchRoom} onCreate={createRoom} onTogglePin={togglePin} onRename={renameRoom} onDelete={deleteRoom} />

        {/* Inner Content Area */}
        <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col justify-between p-5 sm:p-6 overflow-hidden">
          {hasBoard && showTasks && board && <TaskBoard board={board} onAction={taskAction} onOrchestrator={changeOrchestrator} onLocal={ownerLocal} />}
          {canSetup && showTasks && <ProjectSetup key={activeRoom} room={activeRoom} onSetup={ownerLocal} />}
          {/* Chat Messages List, kept mounted under the board so scroll position survives */}
          <div ref={messageList} onScroll={() => {
            const element = messageList.current;
            if (element) followMessages.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
          }} hidden={projectView} className="chat-scroll flex-1 overflow-y-auto space-y-3 pr-1 pt-2" aria-live="polite" aria-label="Chat messages">
            {messages.map((msg) => {
              if (msg.sender === "Claude" || msg.sender === "GPT" || msg.sender === "Gemini") {
                return (
                  <div key={msg.id} className={`chat-message-glass chat-message-glass--${msg.sender.toLowerCase()} flex flex-col gap-1.5`}>
                    <div className="flex items-center gap-2">
                      {msg.sender === "Claude" ? (
                        <ClaudeIcon className="h-5 w-5 shrink-0" />
                      ) : msg.sender === "Gemini" ? (
                        <GeminiIcon className="h-5 w-5 shrink-0" />
                      ) : (
                        <GptIcon className="h-5 w-5 shrink-0" />
                      )}
                      <span className="text-sm text-zinc-200 font-medium">{msg.sender}</span>
                      <MessageTime value={msg.created_at} />
                    </div>
                    <p className="text-sm text-white font-normal whitespace-pre-wrap break-words min-w-0">{msg.message}</p>
                  </div>
                );
              }
              return (
                <div key={msg.id} className="chat-message-glass chat-message-glass--owner flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-200 font-medium">{msg.sender}</span>
                    <MessageTime value={msg.created_at} />
                  </div>
                  <p className="text-sm text-zinc-200 font-normal whitespace-pre-wrap break-words min-w-0">{msg.message}</p>
                </div>
              );
            })}
          </div>

          {/* Bottom Chat Input Bar */}
          <div className="pt-4">
            {(sendError || loadError || exportError || notice) && <p role="alert" className="mb-2 text-xs text-red-300">{sendError || loadError || exportError || notice}</p>}
            <div className="flex items-stretch gap-2">
              <div ref={exportMenu} className="relative flex">
                <button
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  disabled={exporting || !ready}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="Export chat"
                  title="Export chat"
                  className="flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.08] px-3.5 text-sm text-zinc-200 backdrop-blur-md shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)] transition-all hover:border-white/35 hover:bg-white/[0.16] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Export
                </button>
                {menuOpen && (
                  <div role="menu" className="absolute bottom-full left-0 z-20 mb-2 w-56 overflow-hidden rounded-xl border border-white/20 p-1 shadow-[0_12px_30px_rgba(0,0,0,0.55)]" style={{ backgroundColor: "#18181b" }}>
                    {EXPORT_FORMATS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        onClick={() => void handleExport(item.id)}
                        className="flex w-full flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                      >
                        <span className="text-sm text-white">{item.label}</span>
                        <span className="text-xs text-zinc-400">{item.hint}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {(hasBoard || canSetup) && (
                <button
                  type="button"
                  onClick={() => setShowTasks((shown) => !shown)}
                  aria-pressed={showTasks}
                  aria-label={showTasks ? "Show chat" : hasBoard ? "Show tasks" : "Set up project"}
                  title={showTasks ? "Show chat" : hasBoard ? "Show tasks" : "Set up project"}
                  className={`flex items-center gap-1.5 rounded-xl border px-3.5 text-sm backdrop-blur-md shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)] transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${
                    showTasks ? "border-white/35 bg-white/[0.18] text-white" : "border-white/15 bg-white/[0.08] text-zinc-200 hover:border-white/35 hover:bg-white/[0.16]"
                  }`}
                >
                  {hasBoard ? <ListChecks className="h-4 w-4" /> : <FolderGit2 className="h-4 w-4" />}
                  {/* Icon only on phones, so the message field keeps its width */}
                  <span className="hidden sm:inline">{hasBoard ? "Tasks" : "Project"}</span>
                </button>
              )}
              <form onSubmit={handleSend} className="min-w-0 flex-1">
            <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.08] p-2 pl-4 backdrop-blur-md transition-all focus-within:border-white/35 focus-within:bg-white/[0.12] focus-within:ring-1 focus-within:ring-white/20 shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]">
              <input
                type="text"
                value={inputMessage}
                maxLength={4000}
                aria-label="Message"
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Type a message..."
                className="w-full bg-transparent text-sm text-white placeholder-zinc-400 outline-none"
              />
              <button
                type="submit"
                disabled={!inputMessage.trim() || !ready || sending}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white backdrop-blur-md shadow-[inset_0_1px_1.5px_rgba(255,255,255,0.45),0_4px_12px_rgba(0,0,0,0.3)] transition-all hover:bg-white/20 hover:border-white/40 hover:shadow-[inset_0_1px_2px_rgba(255,255,255,0.6),0_6px_16px_rgba(0,0,0,0.4)] active:scale-95 disabled:opacity-30 disabled:border-white/10 disabled:hover:bg-white/10 disabled:cursor-not-allowed"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
