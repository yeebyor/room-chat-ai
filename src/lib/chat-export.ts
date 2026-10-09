import type { ChatMessage, MessageList } from "./chat-types";

export type ExportFormat = "txt" | "md" | "json";

export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "txt", label: "Text (.txt)", hint: "Plain and easy to read" },
  { id: "md", label: "Markdown (.md)", hint: "For notes or documentation" },
  { id: "json", label: "JSON (.json)", hint: "Full data" },
];

const PAGE_SIZE = 200;
const MAX_PAGES = 200;

const byId = (a: ChatMessage, b: ChatMessage) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

// Walks backwards with before_id so the export covers the whole room,
// not just the messages currently rendered.
export async function fetchFullHistory(room: string, signal?: AbortSignal): Promise<ChatMessage[]> {
  const all = new Map<string, ChatMessage>();
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ room, limit: String(PAGE_SIZE) });
    if (before) params.set("before_id", before);
    const response = await fetch(`/api/messages?${params}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load chat history.");
    const messages = (data as MessageList).messages;
    messages.forEach((message) => all.set(message.id, message));
    if (messages.length < PAGE_SIZE) break;
    before = [...messages].sort(byId)[0].id;
  }
  return [...all.values()].sort(byId);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

// Local time of whoever exports, same convention as the on-screen timestamps.
function stamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function formatExport(format: ExportFormat, room: string, messages: ChatMessage[]): { content: string; mime: string } {
  if (format === "json") {
    return {
      mime: "application/json",
      content: JSON.stringify({
        room,
        exported_at: new Date().toISOString(),
        count: messages.length,
        messages: messages.map(({ id, sender, message, created_at, client_id }) => ({ id, sender, message, created_at, client_id })),
      }, null, 2),
    };
  }
  if (format === "md") {
    const body = messages.map((m) => `### ${m.sender} · ${stamp(m.created_at)}\n\n${m.message}`).join("\n\n");
    return { mime: "text/markdown", content: `# Room chat: ${room}\n\nExported ${stamp(new Date().toISOString())} · ${messages.length} messages\n\n${body}\n` };
  }
  const body = messages.map((m) => `[${stamp(m.created_at)}] ${m.sender}: ${m.message}`).join("\n\n");
  return { mime: "text/plain", content: `Room chat: ${room}\nExported ${stamp(new Date().toISOString())} · ${messages.length} messages\n\n${body}\n` };
}

export function downloadFile(filename: string, content: string, mime: string) {
  // BOM keeps non-ASCII text intact when .txt/.md are opened in older Windows editors.
  // JSON stays BOM-free: strict parsers such as JSON.parse reject it.
  const blob = new Blob(mime === "application/json" ? [content] : ["﻿", content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
