// Pure fold of OM Chat "!todo" ledger markers into a board.
// Grammar port of openmarket-chat/src/lib/channel-todos.ts — that file is
// the authority; on divergence, fix THIS copy.
//
// One deliberate simplification: `!release` here removes the releasing
// handle from `holders` rather than reproducing the upstream claim/release
// bookkeeping exactly. Eligibility only asks "is this held by nobody?", and
// any divergence in the holder list errs toward NOT firing — the safe
// direction for an automated pipeline.
export const TODO_EPOCH_MS = Date.UTC(2026, 7, 4);

export type MarkerOp =
  | "todo" | "edit" | "claim" | "release" | "done"
  | "reopen" | "cancel" | "nudge" | "assign" | "unassign";
export interface Marker { op: MarkerOp; title?: string; description?: string; targetHandle?: string }
export interface LedgerEntry {
  seq: number; ts: number; type: string; text?: string; handle: string;
  topicId?: string; inReplyTo?: number; attachments?: unknown[];
  todoCurrent?: { title?: string; description?: string };
}
export interface Todo {
  seq: number; ts: number; title: string; description: string; createdBy: string;
  status: "open" | "done" | "canceled"; holders: string[];
  attachments: unknown[]; eventSeqs: number[];
}

const LIFECYCLE = ["claim", "release", "done", "reopen", "cancel", "nudge"] as const;

function parseContent(trimmed: string, op: "todo" | "edit"): Marker | null {
  const prefix = `!${op}`;
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (!/^\s/.test(rest)) return null;
  const body = rest.trim();
  const nl = body.indexOf("\n");
  const title = (nl < 0 ? body : body.slice(0, nl)).trim();
  if (!title) return null;
  const description = nl < 0 ? "" : body.slice(nl + 1).trim();
  return { op, title, ...(description ? { description } : {}) };
}

function parseTargeted(trimmed: string, op: "assign" | "unassign"): Marker | null {
  const prefix = `!${op}`;
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (!/^\s/.test(rest)) return null;
  const tokens = rest.trim().split(/\s+/);
  if (tokens.length !== 1) return null;
  const token = tokens[0] ?? "";
  const handle = token.replace(/^@/, "").toLowerCase();
  if (!handle || token.toLowerCase() !== `@${handle}`) return null;
  return { op, targetHandle: handle };
}

export function parseMarker(text: string | undefined | null): Marker | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("!")) return null;
  for (const op of LIFECYCLE) if (trimmed === `!${op}`) return { op };
  return (
    parseTargeted(trimmed, "assign") ?? parseTargeted(trimmed, "unassign") ??
    parseContent(trimmed, "edit") ?? parseContent(trimmed, "todo")
  );
}

export function foldTodos(entries: LedgerEntry[]): Map<number, Todo> {
  const board = new Map<number, Todo>();
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    if (e.type !== "post" || e.ts < TODO_EPOCH_MS) continue;
    const m = parseMarker(e.text);
    if (!m) continue;
    if (m.op === "todo") {
      board.set(e.seq, {
        seq: e.seq, ts: e.ts,
        title: e.todoCurrent?.title ?? m.title ?? "",
        description: e.todoCurrent?.description ?? m.description ?? "",
        createdBy: e.handle, status: "open", holders: [],
        attachments: e.attachments ?? [], eventSeqs: [e.seq],
      });
      continue;
    }
    const target = e.inReplyTo === undefined ? undefined : board.get(e.inReplyTo);
    if (!target) continue;
    target.eventSeqs.push(e.seq);
    const hold = (h: string) => { if (!target.holders.includes(h)) target.holders.push(h); };
    const free = (h: string) => { target.holders = target.holders.filter(x => x !== h); };
    switch (m.op) {
      case "claim": hold(e.handle.toLowerCase()); break;
      case "release": free(e.handle.toLowerCase()); break;
      case "assign": hold(m.targetHandle!); break;
      case "unassign": free(m.targetHandle!); break;
      case "done": target.status = "done"; break;
      case "cancel": target.status = "canceled"; break;
      case "reopen": target.status = "open"; target.holders = []; break;
      case "edit":
        target.title = m.title ?? target.title;
        target.description = m.description ?? target.description;
        break;
      case "nudge": break;
    }
  }
  return board;
}

export const eligible = (board: Map<number, Todo>): Todo[] =>
  [...board.values()].filter(t => t.status === "open" && t.holders.length === 0);
