---
name: chat-watch
description: Watch one or more OM Chat rooms and hand every thread that asks for help to a chat-agent that answers it, fixes it with screenshots, and follows it to the end. Event-only (a background watcher wakes the session only when someone asks or replies), one owner agent per thread, follow-ups resumed into the same agent. Trigger: /chat-watch <room ids…> [--trigger <regex>], "watch this room and fix what people ask for", "be the chat agent for #channel".
---

# chat-watch — the coordinator for chat agents

This session is the **coordinator**. It does not answer or fix anything itself. It runs a
watcher, decides which thread each message belongs to, and dispatches or resumes one
`chat-agent` per thread. (This is the Claude-session counterpart of OM Agent, which does the same
job as a daemon on the Mac mini; see the `om-agent` repo.)

## Setup (once per session)

1. **Rooms and grants.** For each room: `room_info` for its space id, then **one**
   `room_grant_request` that asks for every room's `read` + `post` and the spaces' `read`.
   Without `post`, agents can only stage drafts.
2. **Trigger.** Default `@claude\b`: a thread starts only when someone addresses the agent, as
   with OM Agent's `@om-agent`. Nicholas may choose another (e.g. every new top-level post in a
   support channel).
3. **Watcher home:** copy `watchers/chat_watch.sh` to `~/.claude/chat-watch/` (not the session
   scratchpad: `/private/tmp` is wiped on reboot, and a wiped watcher fails silently). Dry-run it:

   ```bash
   DRYRUN=1 SINCE=<a recent seq> ROOMS="<room ids>" TRIGGER='@claude\b' bash ~/.claude/chat-watch/chat_watch.sh
   ```

4. Start it with `run_in_background`. It exits once, printing the lines that need action.

## Each wake-up

| Line | Do |
|---|---|
| `NEW … thread=<key>` | Dispatch a `chat-agent` (background) with room, thread key, trigger seq, and a check-in time 40 min out. Append `<room> <thread> <agent id>` to `owned.txt`. If `thread=-` (a top-level post), use `seq:<seq>` as the key. |
| `FOLLOW-UP … thread=<key>` | `SendMessage` the owner from `owned.txt` with the new lines. Never start a second agent for an owned thread. If the owner is gone, start one with "resume thread <key>; read your branch and MR first". |
| `WATCHER-DOWN` | Check `om` auth (`om auth status`), fix, re-arm. Tell Nicholas if it can't be fixed. |

Then **re-arm the watcher immediately** — before waiting on any agent.

When an agent reports a thread closed, remove its line from `owned.txt`.

## Rules

- **Event-only.** No Monitor re-arm loops, no polling turns: every wake-up is a paid turn.
- **Don't do the work inline,** even when it looks like a one-liner. The agent owns the thread.
- **Cap concurrency at ~4 agents**; queue the rest in the order they arrived and tell the
  thread "queued, N ahead".
- **Merging:** agents never merge. The coordinator merges only when Nicholas said so in *this*
  session, and that permission ends with the session.
- Report to Nicholas in short lines: which thread, what was asked, what was done (MR link),
  what's waiting on whom.
