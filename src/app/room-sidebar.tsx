"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hash, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import type { Room } from "@/lib/chat-types";

export const PINNED_ROOM = "general";
const ROOM_NAME = /^[A-Za-z0-9_-]{1,50}$/;
const NAME_HINT = "Use letters, numbers, - or _";

type Entry = Pick<Room, "name" | "pinned" | "last_message_at">;
// Actions return an error message to show, or null on success.
type Action<Args extends unknown[]> = (...args: Args) => Promise<string | null>;

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

// Same convention as message timestamps: time today, date on earlier days.
function activity(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
}

const focusRing = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40";
const fieldClass = "w-full rounded-xl border border-white/15 bg-white/[0.08] px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none backdrop-blur-md transition-all focus:border-white/35 focus:bg-white/[0.12] disabled:opacity-60 shadow-[inset_0_1px_2px_rgba(255,255,255,0.1)]";

// Room actions live behind a "..." button on the room itself. general has none: it is
// protected. A room the server does not know yet (opened by URL) has nothing to change.
type Manage = { onTogglePin: Action<[string, boolean]>; onRename: Action<[string, string]>; onDelete: Action<[string]> };
const menuItem = `flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-100 transition-colors hover:bg-white/10 disabled:opacity-50 ${focusRing}`;

// Fixed to the viewport (rendered in a portal) so neither the scrolling room list nor
// the glass frame clips it. Closes on Escape,
// a click elsewhere, or scrolling. Delete asks for confirmation first: it is permanent.
function RoomMenu({ room, at, anchor, manage, onRename, onClose }: {
  room: Entry; at: { top: number; left: number }; anchor: HTMLElement | null; manage: Manage; onRename: () => void; onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A press on the "..." trigger is left to its own toggle.
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    const failure = await action();
    setBusy(false);
    if (failure) setError(failure); else onClose();
  };
  return (
    <div ref={panel} role="menu" aria-label={`Actions for ${room.name}`} style={{ top: at.top, left: at.left, backgroundColor: "#18181b" }}
      className="fixed z-50 w-48 rounded-xl border border-white/20 p-1 shadow-[0_12px_30px_rgba(0,0,0,0.55)]">
      {confirming ? (
        <div className="space-y-2 p-2">
          <p className="text-xs text-zinc-300">Delete {room.name} and all its messages? This cannot be undone.</p>
          <div className="flex gap-1.5">
            <button type="button" autoFocus onClick={() => setConfirming(false)} disabled={busy}
              className={`flex-1 rounded-lg border border-white/15 px-2 py-1.5 text-xs text-zinc-200 hover:bg-white/10 ${focusRing}`}>Cancel</button>
            <button type="button" onClick={() => void run(() => manage.onDelete(room.name))} disabled={busy}
              className={`flex-1 rounded-lg border border-red-400/40 bg-red-500/20 px-2 py-1.5 text-xs text-red-100 hover:bg-red-500/30 ${focusRing}`}>
              {busy ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" role="menuitem" autoFocus disabled={busy} className={menuItem}
            onClick={() => void run(() => manage.onTogglePin(room.name, !room.pinned))}>
            {room.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {room.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" role="menuitem" disabled={busy} className={menuItem} onClick={() => { onRename(); onClose(); }}>
            <Pencil className="h-3.5 w-3.5" />Rename
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={() => setConfirming(true)} className={`${menuItem} text-red-200 hover:bg-red-500/15`}>
            <Trash2 className="h-3.5 w-3.5" />Delete
          </button>
        </>
      )}
      {error && <p role="alert" className="px-3 pb-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}

function RoomItem({ room, active, onSelect, manage }: { room: Entry; active: boolean; onSelect: (name: string) => void; manage?: Manage }) {
  const [menu, setMenu] = useState<{ top: number; left: number; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(room.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const Icon = room.pinned ? Pin : Hash;
  // The "..." button shows on the open room, on hover, and while its menu is open.
  const showMenuButton = active || menu !== null;
  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = () => {
    const anchor = trigger.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenu({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 192, window.innerWidth - 200)), anchor });
  };
  const stopRenaming = () => { setRenaming(false); setDraft(room.name); setError(""); };
  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (next === room.name) { stopRenaming(); return; }
    if (!ROOM_NAME.test(next)) { setError(NAME_HINT); return; }
    setBusy(true);
    const failure = await manage!.onRename(room.name, next);
    setBusy(false);
    if (failure) setError(failure); else { setRenaming(false); setError(""); }
  };

  return (
    <div className="shrink-0 md:w-full">
      <div
        className={`group flex items-center rounded-xl border backdrop-blur-md transition-all ${
          active
            ? "border-white/25 bg-white/[0.14] text-white shadow-[inset_0_1px_1.5px_rgba(255,255,255,0.4),0_4px_12px_rgba(0,0,0,0.25)]"
            : "border-transparent text-zinc-300 hover:border-white/15 hover:bg-white/[0.08]"
        }`}
      >
        {renaming ? (
          <form onSubmit={submitRename} onKeyDown={(event) => { if (event.key === "Escape") stopRenaming(); }} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <input autoFocus value={draft} maxLength={50} disabled={busy} onFocus={(event) => event.target.select()}
              onChange={(event) => { setDraft(event.target.value); setError(""); }} onBlur={() => { if (!busy && !error) stopRenaming(); }}
              aria-label={`New name for ${room.name}`} aria-invalid={error ? true : undefined}
              className="min-w-0 flex-1 rounded-md bg-white/[0.08] px-1.5 py-0.5 text-sm text-white outline-none focus:bg-white/[0.12]" />
          </form>
        ) : (
          <button
            type="button"
            onClick={() => onSelect(room.name)}
            aria-current={active ? "page" : undefined}
            title={room.name}
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm active:scale-[0.98] ${focusRing}`}
          >
            <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-white" : "text-zinc-400"}`} />
            <span className="truncate">{room.name}</span>
          </button>
        )}
        {room.last_message_at && !renaming && (
          <span className={`mr-3 shrink-0 text-[10px] tabular-nums text-zinc-500 ${
            manage ? (showMenuButton ? "hidden" : "hidden md:block md:group-hover:hidden md:group-focus-within:hidden") : "hidden md:block"
          }`}>{activity(room.last_message_at)}</span>
        )}
        {manage && !renaming && (
          <button
            ref={trigger}
            type="button"
            onClick={() => (menu ? closeMenu() : openMenu())}
            aria-label={`Room actions for ${room.name}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            className={`mr-1.5 shrink-0 items-center justify-center rounded-lg p-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white ${
              showMenuButton ? "flex" : "hidden group-hover:flex group-focus-within:flex"
            } ${focusRing}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
      {error && <p role="alert" className="px-3 pt-1 text-xs text-red-300">{error}</p>}
      {/* A portal: the glass frame's backdrop-filter would otherwise become the menu's
          containing block, shifting the fixed position and clipping it at the frame edge. */}
      {menu && manage && createPortal(
        <RoomMenu room={room} at={menu} anchor={menu.anchor} manage={manage} onRename={() => setRenaming(true)} onClose={closeMenu} />, document.body)}
    </div>
  );
}

const sectionLabel = "hidden px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 md:block";
const newRoomButton = `flex shrink-0 items-center gap-2 rounded-xl border border-dashed border-white/20 px-3 py-2 text-sm text-zinc-300 backdrop-blur-md transition-all hover:border-white/35 hover:bg-white/[0.08] active:scale-[0.98] ${focusRing}`;

interface RoomSidebarProps {
  activeRoom: string;
  rooms: Room[];
  onSelect: (name: string) => void;
  onCreate: Action<[string]>;
  onTogglePin: Action<[string, boolean]>;
  onRename: Action<[string, string]>;
  onDelete: Action<[string]>;
}

export function RoomSidebar({ activeRoom, rooms, onSelect, onCreate, onTogglePin, onRename, onDelete }: RoomSidebarProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // general is always pinned, even before the room list has loaded. The open room is
  // listed even if the server does not know it yet (e.g. opened by URL).
  const known = rooms.some((room) => room.name === PINNED_ROOM) ? rooms : [{ name: PINNED_ROOM, pinned: true, last_message_at: null }, ...rooms];
  const all: Entry[] = known.some((room) => room.name === activeRoom) ? known : [...known, { name: activeRoom, pinned: false, last_message_at: null }];
  const pinned = [...all.filter((room) => room.name === PINNED_ROOM), ...all.filter((room) => room.pinned && room.name !== PINNED_ROOM)];
  const others = all.filter((room) => !room.pinned && room.name !== PINNED_ROOM);
  // general is protected, and a room the server does not know yet has nothing to change.
  const manage = { onTogglePin, onRename, onDelete };
  const managed = (name: string) => name !== PINNED_ROOM && rooms.some((room) => room.name === name) ? manage : undefined;

  const closeForm = () => { setAdding(false); setDraft(""); setError(""); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!ROOM_NAME.test(name)) { setError(NAME_HINT); return; }
    setBusy(true);
    const failure = await onCreate(name);
    setBusy(false);
    if (failure) { setError(failure); return; }
    closeForm();
  };

  return (
    <aside aria-label="Rooms" className="relative z-10 flex shrink-0 flex-col border-b border-white/[0.12] bg-gradient-to-b from-white/[0.08] to-white/[0.02] shadow-[inset_-1px_0_0_rgba(255,255,255,0.05)] md:w-48 md:border-b-0 md:border-r">
      <nav className="chat-scroll flex gap-1.5 overflow-x-auto p-3 md:min-h-0 md:flex-1 md:flex-col md:overflow-x-visible md:overflow-y-auto md:pt-5">
        <p className={sectionLabel}>Pinned</p>
        {pinned.map((room) => <RoomItem key={room.name} room={room} active={room.name === activeRoom} onSelect={onSelect} manage={managed(room.name)} />)}
        <p className={`${sectionLabel} md:mt-3`}>Rooms</p>
        {others.map((room) => <RoomItem key={room.name} room={room} active={room.name === activeRoom} onSelect={onSelect} manage={managed(room.name)} />)}
        {others.length === 0 && <p className="hidden px-3 py-1 text-xs text-zinc-500 md:block">No other rooms yet.</p>}
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} aria-label="New room" className={`${newRoomButton} md:hidden`}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </nav>
      <div className={adding ? "p-3 pt-0 md:pt-3" : "hidden p-3 md:block"}>
        {adding ? (
          <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") closeForm(); }}>
            <input
              autoFocus
              value={draft}
              maxLength={50}
              disabled={busy}
              onChange={(event) => { setDraft(event.target.value); setError(""); }}
              aria-label="Room name"
              aria-invalid={error ? true : undefined}
              placeholder="room-name"
              className={fieldClass}
            />
            {error && <p role="alert" className="mt-1.5 text-xs text-red-300">{error}</p>}
          </form>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={`${newRoomButton} w-full`}>
            <Plus className="h-3.5 w-3.5" />
            New room
          </button>
        )}
      </div>
    </aside>
  );
}
