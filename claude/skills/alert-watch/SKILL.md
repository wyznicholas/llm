---
name: alert-watch
description: Own the alerts of one or more services — run an event-only watcher per alert source, and for every real alert dispatch one alert-agent with a 1-hour deadline to prove the cause and fix it (MR, or the owning team named with evidence). Resumes the same agent when the same alert fires again; tells Nicholas what broke, why, which MR fixed it, which tag must be deployed. Trigger: /alert-watch <service…>, "be responsible for this alert", "make sure X never fires again", "monitor <service> like the kscript canary".
---

# alert-watch — the coordinator for alert agents

This session is the **coordinator**. It owns a set of services' alerts. It never investigates
inline: it watches, decides whether an event is new, and dispatches or resumes one
`alert-agent` per alert class.

## Vocabulary

- **Alert source** — where a service reports trouble: an OM Chat room it posts to, a Loki
  query, a health endpoint, a Prometheus rule.
- **Watcher** — a small shell script that polls one source and **exits** only when something
  needs attention, printing one line per event. Exiting is what wakes this session.
- **Alert class** — the same failure on the same thing (e.g. "perf-sentinel zoo-stress-gauntlet
  step 11 lazyback stalled"). One class, one owner agent.

## Live watchers (copies in `watchers/`)

| Watcher | Service | Source | Wakes on |
|---|---|---|---|
| `perf_room_watch.sh` | perf-sentinel, app-data-canary, cme-data-canary | room #web-mobile-parity `16b1651e4ff5` + pod logs | a new alert post not already owned; dropped webhook deliveries; CME stall while the live feed isn't confirmed healthy |
| `perf_cycle_watch.sh` | perf-sentinel | Loki `perf_cycle_fail` (every failure, not just the first) | scenario RED / TIMEOUT / INVALID; latency p95 ≥ 3× budget |
| `chart_watch.sh` | om-agent chart probe | #chat `82eae63a1bd3` topic `fc1afe21` + `/healthz` on the mini | 🔴 chart-down post; agent unhealthy 3 polls |

Live copies sit in `~/.claude/perf-watch/` and `~/.claude/om-agent-watch/` with their state
files (`.seq`, `.known`, `suppressed.log`). Never in a session scratchpad: a reboot wiped one
on 10-16 and left four days unwatched.

## Writing a watcher for a new service

Copy the closest one and keep its contract:

- Poll the source on an interval that matches how often it changes (60–120 s for rooms).
- Remember the last thing seen in a state file beside the script (`<name>.seq` / `.ts`), so a
  restart neither replays nor skips.
- Print `LABEL<TAB>details` per event and **exit 0**; batch for 30–300 s after the first hit so
  one bad cycle is one wake-up.
- Exit 1 with `WATCHER-DOWN` after ~10 failed polls. A dead watcher must never look like quiet.
- If silence is the only sign of health (the service posts nothing when green), add a liveness
  check — a dead service posts nothing too.
- `DRYRUN=1` runs one poll and prints what it would wake on.
- `<name>.known`: regexes for repeats someone already owns. Scope each to the exact false-alarm
  shape or window, never a whole alert class that can also be real. Log everything filtered to
  `<name>.suppressed.log` with the reason.

## Each wake-up

1. Read the event lines. Check `suppressed.log` if it looks like a known repeat.
2. **New alert class** → dispatch an `alert-agent` (background) with: the event lines, the
   service, its alert source and logs, the deployed tag if known, and an **absolute UTC
   deadline one hour out** with a check-in 15 min before it.
3. **Same class as an owner already has** → `SendMessage` that owner. Never a second owner.
4. **`WATCHER-DOWN`** → fix the access (VPN for Loki, `aws-mfa-login` for eks, `om` auth),
   re-arm, and tell Nicholas what lapsed.
5. **Re-arm the watcher immediately**, before waiting on any agent.

## Rules

- **Event-only.** No Monitor loops, no polling turns, no "still quiet" messages.
- **Merging** is the coordinator's, only after Nicholas says so in *this* session; it does not
  carry over from another session or a handoff note.
- **Merging is not deploying.** Report the exact tag to roll out, and after the deploy, treat the
  first cycle as the proof: a recurrence after that is a real failure of the fix → resume its owner.
- **Moving the watch** to another machine or session: write a handoff (the job, host checks,
  watcher seqs to carry over, what's in flight, who's waiting on what), and stop the old
  watchers once the new ones run, so nothing is handled twice.

Report to Nicholas, short and plain: what broke, the cause, the MR, the tag to deploy, and
what's waiting on whom.
