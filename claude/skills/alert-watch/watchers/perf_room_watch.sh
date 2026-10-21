#!/bin/bash
# Event-only watcher for #web-mobile-parity (16b1651e4ff5), where perf-sentinel, app-data-canary and the
# CME data-canary post. Polls every 60s; exits printing every new post that needs a human or an agent,
# batching for 45s after the first hit so one cycle = one wake-up.
#   ROOM            a new alert post not covered by a rule below
#   DROPPED         pod log "[alert] feed <code> FAILED" (needs eks auth; silently skipped without it)
#   CME-FEED-CHECK  a CME live-stalled post while users' live feed could not be confirmed healthy
#   WATCHER-DOWN    om CLI failed 10 polls in a row
# Rules, newest lesson first:
#   - never ignore a whole alert class that can also be real (10-16: hid real-hours CME stalls);
#   - perf_room_watch.known = regexes for repeats already owned by an agent/person, scoped tightly;
#   - CME live-stalled is dropped only while both live-feed-cme-rt pods log healthy (canary token has no
#     live entitlement, so its own stall says nothing about users);
#   - "cme-data-canary: N alert(s)" carries no detail, so the detail is read from Loki and the post is
#     dropped only when every alert line is a known class (NQZ6 tv-price boundary disagreement; CLX6
#     symbol-stale while its roll is being fixed).
D=$(dirname "$0")
ROOM=16b1651e4ff5
L=https://logs.productionv2.int.tharamine.com
SEQF="$D/perf_room_watch.seq"; LOGF="$D/perf_room_watch.logts"
[ -s "$SEQF" ] || om room history $ROOM --limit 1 --format json 2>/dev/null | jq -r '.upToSeq' > "$SEQF"
[ -s "$LOGF" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$LOGF"
fails=0
poll() {
  since=$(cat "$SEQF")
  json=$(om room history $ROOM --since-seq "$since" --limit 200 --format json 2>/dev/null)
  up=$(jq -er '.upToSeq' <<<"$json" 2>/dev/null) || return 1
  jq -r '.entries[] | select(.text|test("^Fixed")|not) | "ROOM\tseq=\(.seq)\t\(.ts/1000|strftime("%H:%M:%SZ"))\t\(.text[0:300]|gsub("\n";" "))"' <<<"$json"
  [ "$up" -gt "$since" ] 2>/dev/null && echo "$up" > "$SEQF"
  lsince=$(cat "$LOGF"); now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  kubectl --context eks -n pub logs deploy/perf-sentinel --since-time="$lsince" --request-timeout=30s 2>/dev/null \
    | grep -a -E '^\[alert\] feed [0-9]+ FAILED' | sed 's/^/DROPPED\t/'
  echo "$now" > "$LOGF"
  return 0
}
filter() {
  local out="$1"
  [ -s "$D/perf_room_watch.known" ] && out=$(grep -a -v -E -f "$D/perf_room_watch.known" <<<"$out")
  if grep -qaE '(CME|COMEX):[A-Z0-9]+\] live-stalled' <<<"$out"; then
    ok=1
    for p in live-feed-cme-rt-0 live-feed-cme-rt-1; do
      lg=$(kubectl --context cme -n pub logs $p --since=5m --request-timeout=20s 2>/dev/null) || { ok=0; break; }
      { [ "$(grep -c 'healthy, no lag' <<<"$lg")" -gt 0 ] && ! grep -qi 'unhealthy' <<<"$lg"; } || ok=0
    done
    if [ "$ok" = 1 ]; then
      grep -aE '(CME|COMEX):[A-Z0-9]+\] live-stalled' <<<"$out" | sed 's/$/\t(feed healthy, not woken)/' >> "$D/perf_room_watch.suppressed.log"
      out=$(grep -avE '(CME|COMEX):[A-Z0-9]+\] live-stalled' <<<"$out")
    else
      out=$(printf '%s\nCME-FEED-CHECK\tlive-feed-cme-rt not confirmed healthy (or cme unreadable)\n' "$out")
    fi
  fi
  if grep -qa 'cme-data-canary: [0-9]* alert(s)' <<<"$out"; then
    det=$(curl -s -G --max-time 30 "$L/loki/api/v1/query_range" \
      --data-urlencode 'query={namespace="pub", pod=~"perf-sentinel.*"} |~ "^\\[delayed/"' \
      --data-urlencode "start=$(( $(date +%s) - 300 ))000000000" --data-urlencode limit=50 \
      | jq -r '.data.result[].values[][1]' 2>/dev/null)
    if [ -n "$det" ] && ! grep -qavE '^\[delayed/NQZ6\] tv-price:|^\[delayed/CLX6\] symbol-stale:' <<<"$det"; then
      printf '%s\t(known: %s)\n' "$(grep -a 'cme-data-canary' <<<"$out" | head -1)" "$(head -1 <<<"$det" | cut -c1-160)" >> "$D/perf_room_watch.suppressed.log"
      out=$(grep -av 'cme-data-canary: [0-9]* alert(s)' <<<"$out")
    fi
  fi
  printf '%s' "$out" | sed '/^$/d'
}
# DRYRUN=1: one poll + filter, print raw count and filtered result, exit (for testing).
if [ -n "$DRYRUN" ]; then r=$(poll); echo "raw lines: $(grep -c . <<<"$r")"; echo "after filter: [$(filter "$r")]"; exit 0; fi
while true; do
  if ! raw=$(poll); then
    fails=$((fails+1))
    [ "$fails" -eq 10 ] && { echo "WATCHER-DOWN om room history failing for 10 polls ($(date -u +%H:%M:%SZ))"; exit 1; }
    sleep 60; continue
  fi
  fails=0
  out=$(filter "$raw")
  if [ -n "$out" ]; then
    sleep 45; more=$(filter "$(poll)")
    printf '%s\n%s\n' "$out" "$more" | sed '/^$/d'; exit 0
  fi
  sleep 60
done
