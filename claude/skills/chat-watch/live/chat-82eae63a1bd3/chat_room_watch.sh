#!/bin/bash
# Event-only watcher for #chat (82eae63a1bd3): bug reports, feature requests and !todo items for
# openmarket-chat / openmarket-internal. Polls every 60s; exits printing every new post that needs
# triage, batching for 45s after the first hit so one burst = one wake-up.
#   POST           a new human post (incl. !todo / !edit / !reopen and replies to the agent's questions)
#   WATCHER-DOWN   om CLI failed 10 polls in a row
# Not woken for: agent badges (isAgent, e.g. the chart probe), the agent's own posts (start with 🤖),
# and bare lifecycle markers (!claim / !done / !release / !assign / !unassign / !nudge / !cancel).
D=$(dirname "$0")
ROOM=82eae63a1bd3
SEQF="$D/seq"
[ -s "$SEQF" ] || om room history $ROOM --limit 1 --format json 2>/dev/null | jq -r '.upToSeq' > "$SEQF"
fails=0
poll() {
  since=$(cat "$SEQF")
  json=$(om room history $ROOM --since-seq "$since" --limit 200 --format json 2>/dev/null)
  up=$(jq -er '.upToSeq' <<<"$json" 2>/dev/null) || return 1
  jq -r '.entries[]
    | select(.isAgent != true)
    | select(.text | test("^🤖") | not)
    | select(.text | test("^!(claim|done|release|assign|unassign|nudge|cancel)\\b") | not)
    | "POST\tseq=\(.seq)\t\(.ts/1000|strftime("%m-%d %H:%MZ"))\t@\(.handle)\ttopic=\(.topicId // "-")\treplyTo=\(.inReplyTo // "-")\t\(.text[0:500]|gsub("\n";" ⏎ "))"' <<<"$json"
  [ "$up" -gt "$since" ] 2>/dev/null && echo "$up" > "$SEQF"
  return 0
}
if [ -n "$DRYRUN" ]; then poll; exit 0; fi
while true; do
  if ! out=$(poll); then
    fails=$((fails+1))
    [ "$fails" -eq 10 ] && { echo "WATCHER-DOWN om room history failing for 10 polls ($(date -u +%H:%M:%SZ))"; exit 1; }
    sleep 60; continue
  fi
  fails=0
  if [ -n "$out" ]; then
    sleep 45; more=$(poll)
    printf '%s\n%s\n' "$out" "$more" | sed '/^$/d'; exit 0
  fi
  sleep 60
done
