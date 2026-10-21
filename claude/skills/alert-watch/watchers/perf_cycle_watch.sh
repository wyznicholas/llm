#!/bin/bash
# Event-only watcher for perf-sentinel production cycles, read from Loki's perf_cycle_fail events
# (every failure of a cycle; the alert room #web-mobile-parity 16b1651e4ff5 shows only the first).
# Exits with one line per real event:
#   SCENARIO      any scenario:RED / TIMEOUT / INVALID (any production scenario)
#   BLOWUP        an invariant latency-p95 at >= 3x its budget
#   WATCHER-DOWN  Loki unreachable for 10 polls (VPN?)
# Ignored on purpose: duplicate-network and latency-p95 under 3x budget (known, handed off 10-14).
D=$(dirname "$0")
L=https://logs.productionv2.int.tharamine.com
TSF="$D/perf_cycle_watch.ts"
[ -s "$TSF" ] || echo "$(date +%s)000000000" > "$TSF"
fails=0
while true; do
  since=$(cat "$TSF")
  json=$(curl -s -G --max-time 30 "$L/loki/api/v1/query_range" \
    --data-urlencode 'query={namespace="pub"} |= "\"event\":\"perf_cycle_fail\""' \
    --data-urlencode "start=$((since + 1))" --data-urlencode "limit=50" --data-urlencode direction=forward)
  if ! jq -e '.status=="success"' <<<"$json" >/dev/null 2>&1; then
    fails=$((fails+1))
    [ "$fails" -eq 10 ] && { echo "WATCHER-DOWN Loki unreachable for 10 polls ($(date -u +%H:%M:%SZ)); VPN?"; exit 1; }
    sleep 120; continue
  fi
  fails=0
  last=$(jq -r '[.data.result[].values[][0]] | max // empty' <<<"$json")
  hits=$(jq -r '.data.result[].values[] | .[1] | fromjson? | select(.event=="perf_cycle_fail") | .cycleId as $c | .failures[]
      | if test("scenario:(RED|TIMEOUT|INVALID)") then "SCENARIO\t\($c)\t\(.[0:300])"
        elif test("invariant:latency-p95") then
          (capture("p95 (?<v>[0-9.]+)ms \\(budget (?<b>[0-9.]+)ms") // null) as $m
          | if $m != null and (($m.v|tonumber) >= 3*($m.b|tonumber)) then "BLOWUP\t\($c)\t\(.[0:300])" else empty end
        else empty end' <<<"$json" 2>/dev/null)
  [ -n "$last" ] && echo "$last" > "$TSF"
  if [ -n "$hits" ]; then echo "$hits"; exit 0; fi
  sleep 120
done
