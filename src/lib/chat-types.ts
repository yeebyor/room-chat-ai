export type Sender = "yeebyor" | "Claude" | "GPT" | "Gemini";

export interface ChatMessage {
  id: string;
  client_id: string;
  sender: Sender;
  room: string;
  message: string;
  created_at: string;
}

export interface Room {
  name: string;
  created_at: string;
  pinned: boolean;
  message_count: number;
  last_message_at: string | null;
}

export interface RoomList {
  rooms: Room[];
}

export type Agent = Exclude<Sender, "yeebyor">;

export interface Turn {
  next: Agent | null;
  stopped: boolean;
  probabilities: Record<Agent, number> | null;
  roll: number | null;
  last_id: string | null;
  last_sender: Sender | null;
  open_at: string | null;
  called: Agent[];
  present: Agent[];
  listening: Agent[];
  gather_until: string | null;
  gather_seed: string | null;
  owner_called_until: string | null;
}

export interface MessageList {
  room: string;
  messages: ChatMessage[];
  count: number;
  turn: Turn;
}

// HFMA board (op "board" on POST /api/hfma); see HFMA.md.
export interface HfmaCriterion {
  id: string;
  text: string;
  check: "command" | "owner";
  command?: string;
}

// One command criterion run by the owner's close action.
export interface CriterionRun {
  id: string;
  passed: boolean;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  output: string;
}

// What an owner action on this machine returns: an error to show, plus any criterion runs.
export interface LocalResult {
  error: string | null;
  results?: CriterionRun[];
}
export type TaskStatus = "TODO" | "CLAIMED" | "REVIEW" | "APPROVED" | "DONE" | "BLOCKED" | "CANCELLED";

export interface HfmaTask {
  id: number;
  title: string;
  team: Agent;
  status: TaskStatus;
  generation: number;
  depends_on: number[];
  candidate: string | null;
  approved_hash: string | null;
  merge_hash: string | null;
  block_reason: string | null;
  exception: boolean;
  stale: boolean | null;
}

export interface HfmaDecision {
  id: number;
  key: string;
  title: string;
  body: string;
  actor: string;
  status: "active" | "conflict" | "superseded" | "rejected";
  supersedes: number | null;
  conflicts_with: number | null;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
}

export interface HfmaBoard {
  room: string;
  charter_version: number | null;
  decisions: HfmaDecision[];
  // Added by the page from the charter; not part of the board op itself.
  orchestrator?: Agent;
  criteria?: HfmaCriterion[];
  agents?: Agent[];
  project: { main_hash: string | null; inconsistent: boolean | null; closed_at: string | null };
  tasks: HfmaTask[];
}
