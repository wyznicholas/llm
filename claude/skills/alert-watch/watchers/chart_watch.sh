#!/bin/bash
# Event-only watcher for om-agent's report topic: #chat (82eae63a1bd3) topic fc1afe21 "[DO NOT DELETE] OM Agent".
# Goal (Nicholas, 2026-10-20): om-agent's chart probe should always pass. Polls every 120s and exits only on:
#   CHART-DOWN    a new om-agent 🔴 post in the topic (batched 5 min, so the matching "back" post rides along)
#   AGENT-DOWN    om-agent's /healthz on the mini not 200 for 3 polls in a row (a dead agent posts nothing,
#                 and silence must never read as a passing chart)
#   BLIP          (only with BLIPS=1) a failed probe in om-agent's chart_probe_results that chat never saw (since om-agent!130 a
#                 lone failure is held back). Kept while the :10-slot blips are unexplained; compare against
#                 ~/chart-vantage.log on oms-mac-mini and emu-box (curl every 20s). Drop once the cause is fixed.
#   WATCHER-DOWN  om CLI failed 10 polls in a row
# 🟢 posts (OK / back) and other agents' posts never wake. Last seen seq lives in chart_watch.seq.
D=$(dirname "$0")
ROOM=82eae63a1bd3; TOPIC=fc1afe21
SEQF="$D/chart_watch.seq"
[ -s "$SEQF" ] || om room history $ROOM --limit 1 --format json 2>/dev/null | jq -r '.upToSeq' > "$SEQF"
poll() {
  since=$(cat "$SEQF")
  json=$(om room history $ROOM --since-seq "$since" --limit 200 --format json 2>/dev/null)
  up=$(jq -er '.upToSeq' <<<"$json" 2>/dev/null) || return 1
  jq -r --arg t "$TOPIC" '.entries[] | select(.topicId==$t and .handle=="om-agent")
    | "\(if (.text|startswith("🔴")) then "CHART-DOWN" else "INFO" end)\tseq=\(.seq)\t\(.ts/1000|strftime("%H:%M:%SZ"))\t\(.text[0:400]|gsub("\n";" "))"' <<<"$json"
  [ "$up" -gt "$since" ] 2>/dev/null && echo "$up" > "$SEQF"
  return 0
}
BLIPF="$D/chart_watch.blip"
[ -s "$BLIPF" ] || echo $(( $(date +%s) * 1000 )) > "$BLIPF"
blips() {
  since=$(cat "$BLIPF")
  rows=$(ssh -o BatchMode=yes -o ConnectTimeout=15 oms-mac-mini "sqlite3 -separator '	' 'file:/Users/ombot/repos/om-agent/.state/state.sqlite?mode=ro' \"select at, strftime('%H:%M:%SZ', at/1000, 'unixepoch'), failure, total_ms || 'ms', substr(detail,1,160) from chart_probe_results where ok=0 and at > $since order by at\"" 2>/dev/null) || return 0
  [ -z "$rows" ] && return 0
  tail -1 <<<"$rows" | cut -f1 > "$BLIPF"
  cut -f2- <<<"$rows" | sed 's/^/BLIP	/'
}
health() { ssh -o BatchMode=yes -o ConnectTimeout=15 oms-mac-mini 'curl -s -o /dev/null -m 10 -w "%{http_code}" 127.0.0.1:7717/healthz' 2>/dev/null; }
if [ -n "$DRYRUN" ]; then [ -n "$SINCE" ] && echo "$SINCE" > "$SEQF"; [ -n "$BLIPSINCE" ] && echo "$BLIPSINCE" > "$BLIPF"; poll; blips; echo "healthz=$(health)"; exit 0; fi
fails=0; sick=0
while true; do
  if ! out=$(poll); then
    fails=$((fails+1)); [ "$fails" -ge 10 ] && { echo "WATCHER-DOWN om room history failing 10 polls ($(date -u +%H:%M:%SZ))"; exit 1; }
  else
    fails=0
    if grep -q '^CHART-DOWN' <<<"$out"; then
      sleep 300; more=$(poll)
      printf '%s\n%s\n' "$out" "$more" | sed '/^$/d'; exit 0
    fi
  fi
  # BLIP wake-ups off since 2026-10-20 23:30Z: the cause is located (about one minute of blk origin
  # unreachability, from both office vantages AND through Cloudflare), and more samples add nothing.
  # Re-enable with BLIPS=1 if the cause has to be re-measured.
  if [ -n "$BLIPS" ]; then b=$(blips); [ -n "$b" ] && { echo "$b"; exit 0; }; fi
  code=$(health)
  if [ "$code" = 200 ]; then sick=0; else sick=$((sick+1)); fi
  [ "$sick" -ge 3 ] && { echo "AGENT-DOWN om-agent /healthz=${code:-unreachable} for 3 polls ($(date -u +%H:%M:%SZ))"; exit 0; }
  sleep 120
done
