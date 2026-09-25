#!/usr/bin/env bun
// topic-context.ts — the investigation lever.
//
// A to-do title is never the whole task. This prints, as markdown, everything
// an investigator needs around one to-do: the to-do itself, the report it was
// promoted from, every reply in its thread, and the surrounding topic
// conversation — plus it downloads the attachments on those messages so a
// screenshot or screen recording can be looked at.
//
// Usage:
//   bun topic-context.ts --todo <createSeq> [--window 40] [--out <dir>]
//                        [--daemon <url>] [--no-download]
//
// Attachments land in --out (default ~/.claude/om-bug-loop/evidence/<seq>/context/).
// Video files keep their extension so a frame can be pulled. ffmpeg is NOT
// installed on this Mac, so the emitted frame command falls back to Quick
// Look, which is built in and produced a legible frame in testing:
//   qlmanage -t -s 1400 -o <outdir> in.mov      # → <outdir>/in.mov.png
//   ffmpeg -ss 2 -i in.mov -frames:v 1 out.png  # preferred, if ever installed
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { DEFAULT_DAEMON, DaemonClient, PAGE_PAUSE_MS, ROOM, TOPIC, type LedgerEntryRaw } from "./daemon-api";
import { parseMarker } from "./todo-fold";

const MAX_PAGES = 150;
const HAS_FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].some(existsSync);

/** A frame-extract command that actually runs on this machine. */
const frameCommand = (video: string) =>
  HAS_FFMPEG
    ? `ffmpeg -ss 2 -i "${video}" -frames:v 1 "${video}.png"`
    : `qlmanage -t -s 1400 -o "${dirname(video)}" "${video}"   # → ${video}.png`;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TODO_SEQ = Number(argValue("--todo") ?? NaN);
const WINDOW = Number(argValue("--window") ?? 40);
const DAEMON = argValue("--daemon") ?? DEFAULT_DAEMON;
const NO_DOWNLOAD = process.argv.includes("--no-download");
const OUT_DIR = argValue("--out")
  ?? join(homedir(), ".claude", "om-bug-loop", "evidence", String(TODO_SEQ), "context");

if (!Number.isFinite(TODO_SEQ)) {
  process.stderr.write("usage: bun topic-context.ts --todo <createSeq> [--window 40] [--out <dir>]\n");
  process.exit(64);
}

const daemon = new DaemonClient(DAEMON);
const log = (m: string) => process.stderr.write(`[topic-context] ${m}\n`);

// ------------------------------------------------------- collect the topic

/**
 * Page backwards from the room tip, keeping topic entries, until the window
 * below the to-do is covered. The window is counted in TOPIC messages, not
 * room messages — #dev-forums carries a lot of bot traffic in other topics.
 */
async function collectTopic(): Promise<LedgerEntryRaw[]> {
  const collected = new Map<number, LedgerEntryRaw>();
  let before = Number.MAX_SAFE_INTEGER;
  let sawTodo = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await daemon.events({ beforeSeq: before });
    const entries = res.entries ?? [];
    if (entries.length === 0) break;
    for (const e of entries) if (e.topicId === TOPIC) collected.set(e.seq, e);
    const oldest = entries.reduce((a, b) => (a.seq <= b.seq ? a : b));
    if (oldest.seq <= TODO_SEQ) sawTodo = true;
    // stop once we hold WINDOW topic messages older than the to-do
    const olderThanTodo = [...collected.values()].filter(e => e.seq < TODO_SEQ).length;
    if (sawTodo && olderThanTodo >= WINDOW) break;
    if (!res.hasMore) break;
    before = oldest.seq;
    await Bun.sleep(PAGE_PAUSE_MS);
  }
  return [...collected.values()].sort((a, b) => a.seq - b.seq);
}

// ------------------------------------------------------------ attachments

interface Downloaded { seq: number; name: string; path: string; bytes: number }

function attachmentKey(a: Record<string, unknown>): string | null {
  for (const k of ["key", "storageKey", "objectKey", "path", "id"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function attachmentName(a: Record<string, unknown>, key: string): string {
  for (const k of ["name", "filename", "fileName", "originalName"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  const tail = key.split("/").pop() ?? key;
  return tail || "attachment";
}

async function downloadAttachments(entries: LedgerEntryRaw[]): Promise<Downloaded[]> {
  const out: Downloaded[] = [];
  const withFiles = entries.filter(e => Array.isArray(e.attachments) && e.attachments.length > 0);
  if (withFiles.length === 0) return out;
  mkdirSync(OUT_DIR, { recursive: true });
  for (const entry of withFiles) {
    for (const [i, raw] of (entry.attachments as Record<string, unknown>[]).entries()) {
      const key = attachmentKey(raw);
      if (!key) { log(`entry ${entry.seq} attachment ${i}: no resolvable key`); continue; }
      try {
        const url = await daemon.attachmentUrl(key);
        if (!url) { log(`entry ${entry.seq} attachment ${i}: no signed url`); continue; }
        const abs = url.startsWith("http") ? url : `${daemon.origin}${url}`;
        const res = abs.startsWith(daemon.origin)
          ? await daemon.fetchRaw(abs.slice(daemon.origin.length))
          : await fetch(abs);
        if (!res.ok) { log(`entry ${entry.seq} attachment ${i}: download ${res.status}`); continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const name = attachmentName(raw, key);
        // keep the extension: video needs it for the ffmpeg frame-extract fallback
        const safe = `${entry.seq}-${i}-${name.replace(/[^\w.\-]+/g, "_")}${extname(name) ? "" : ".bin"}`;
        const path = join(OUT_DIR, safe);
        writeFileSync(path, bytes);
        out.push({ seq: entry.seq, name, path, bytes: bytes.byteLength });
        log(`downloaded ${path} (${bytes.byteLength} bytes)`);
      } catch (err) {
        log(`entry ${entry.seq} attachment ${i}: ${(err as Error).message}`);
      }
      await Bun.sleep(PAGE_PAUSE_MS);
    }
  }
  return out;
}

// ---------------------------------------------------------------- render

const stamp = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";

function renderEntry(e: LedgerEntryRaw, downloads: Downloaded[]): string {
  const marker = parseMarker(e.text);
  const tag = marker ? ` \`[!${marker.op}]\`` : "";
  const reply = e.inReplyTo ? ` (reply to ${e.inReplyTo})` : "";
  const files = downloads.filter(d => d.seq === e.seq);
  const body = (e.text ?? "").trim() || "_(no text)_";
  const fileLines = files.map(f => `\n  - attachment: \`${f.path}\` (${f.bytes} bytes)`).join("");
  const unresolved =
    Array.isArray(e.attachments) && e.attachments.length > files.length && files.length === 0
      ? `\n  - attachment present but not downloaded: \`${JSON.stringify(e.attachments).slice(0, 200)}\``
      : "";
  return `- **${stamp(e.ts)} · @${e.handle}** (seq ${e.seq})${reply}${tag}\n\n  ${body.replace(/\n/g, "\n  ")}${fileLines}${unresolved}`;
}

const main = async () => {
  const topic = await collectTopic();
  const bySeq = new Map(topic.map(e => [e.seq, e]));
  const todo = bySeq.get(TODO_SEQ);
  if (!todo) {
    process.stderr.write(`to-do create seq ${TODO_SEQ} not found in topic ${TOPIC}\n`);
    process.exit(1);
  }

  const marker = parseMarker(todo.text);
  const title = todo.todoCurrent?.title ?? marker?.title ?? "(untitled)";
  const description = todo.todoCurrent?.description ?? marker?.description ?? "";

  // The report the to-do was promoted from, when there is one.
  const source = todo.inReplyTo ? bySeq.get(todo.inReplyTo) : undefined;
  // Everything replying into this to-do's thread (lifecycle markers + talk).
  const thread = topic.filter(e => e.inReplyTo === TODO_SEQ && e.seq !== TODO_SEQ);
  // Surrounding conversation: WINDOW topic messages either side.
  const idx = topic.findIndex(e => e.seq === TODO_SEQ);
  const around = topic.slice(Math.max(0, idx - WINDOW), idx + WINDOW + 1);

  const interesting = new Map<number, LedgerEntryRaw>();
  for (const e of [...(source ? [source] : []), todo, ...thread, ...around]) interesting.set(e.seq, e);
  const downloads = NO_DOWNLOAD ? [] : await downloadAttachments([...interesting.values()]);

  const link = `http://localhost:31417/rooms#/${ROOM}/topic/${TOPIC}`;
  const lines: string[] = [
    `# Topic context for to-do ${TODO_SEQ}`,
    "",
    `**Title:** ${title}`,
    `**Created by:** @${todo.handle} at ${stamp(todo.ts)}`,
    `**Topic:** ⌗ OM Chat Bugs (\`${TOPIC}\`) in room \`${ROOM}\` — ${link}`,
    "",
    description ? `**Description:**\n\n${description}\n` : "_(no description on the to-do)_\n",
    "## Source report (what the to-do was promoted from)",
    "",
    source ? renderEntry(source, downloads) : "_The to-do was not a reply to an earlier message._",
    "",
    "## Thread on this to-do",
    "",
    thread.length ? thread.map(e => renderEntry(e, downloads)).join("\n\n") : "_No replies._",
    "",
    `## Surrounding topic conversation (±${WINDOW} messages)`,
    "",
    around.map(e => (e.seq === TODO_SEQ ? `${renderEntry(e, downloads)}\n\n  ⬆︎ **this is the to-do**` : renderEntry(e, downloads))).join("\n\n"),
    "",
  ];

  if (downloads.length) {
    lines.push("## Downloaded attachments", "");
    for (const d of downloads) {
      const isVideo = /\.(mov|mp4|webm|m4v)$/i.test(d.path);
      lines.push(`- seq ${d.seq}: \`${d.path}\` (${d.bytes} bytes)` +
        (isVideo ? `\n  - frame: \`${frameCommand(d.path)}\`` : ""));
    }
    lines.push("");
  }

  process.stdout.write(lines.join("\n"));
};

await main();
