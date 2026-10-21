#!/bin/bash
# Event-only watcher for the chat-watch skill. Polls each room in $ROOMS every 60s and exits,
# printing one line per message that needs a chat agent:
#   NEW           a human message matching $TRIGGER that is not inside a thread an agent already owns
#   FOLLOW-UP     any human message inside an owned thread (a topic id or root seq listed in owned.txt),
#                 mention or not: following the thread through is the whole point of a chat agent
#   WATCHER-DOWN  om CLI failed 10 polls in a row for a room
# Messages from agents (isAgent) never wake it, so the agent's own replies cannot loop it.
# Hits are batched for 30s so a burst of messages ("it's broken" + screenshot + "on mobile") is one wake-up.
#
# State, all beside this script (never in a session scratchpad: a reboot wipes /private/tmp):
#   <room>.seq    last seq read per room
#   owned.txt     one "<room> <topicId|seq:N> <owner-agent-id>" per line; the coordinator appends on dispatch
#                 and removes the line when the thread is closed
#
# Usage:  ROOMS="7950af2f4f4a 82eae63a1bd3" TRIGGER='@claude\b' bash chat_watch.sh
#         DRYRUN=1 SINCE=440 ROOMS=7950af2f4f4a bash chat_watch.sh    # one poll from seq 440, print, exit
D=$(dirname "$0")
: "${ROOMS:?set ROOMS to space-separated room ids}"
TRIGGER=${TRIGGER:-'@claude\b'}
OWNED="$D/owned.txt"; touch "$OWNED"

poll_room() {
  local room=$1 seqf="$D/$1.seq" since json up
  [ -n "$DRYRUN" ] && [ -n "$SINCE" ] && echo "$SINCE" > "$seqf"
  [ -s "$seqf" ] || om room history "$room" --limit 1 --format json 2>/dev/null | jq -r '.upToSeq' > "$seqf"
  since=$(cat "$seqf")
  json=$(om room history "$room" --since-seq "$since" --limit 200 --format json 2>/dev/null)
  up=$(jq -er '.upToSeq' <<<"$json" 2>/dev/null) || return 1
  # Owned threads for this room, as a JSON array of "topicId" or "seq:N" keys.
  owned=$(awk -v r="$room" '$1==r {print $2}' "$OWNED" | jq -R . | jq -sc .)
  jq -r --arg room "$room" --arg trig "$TRIGGER" --argjson owned "$owned" '
    .entries[] | select(.isAgent | not) | select(.type == null or .type == "post")
    | (if .topicId then .topicId elif .inReplyTo then "seq:\(.inReplyTo)" else null end) as $thread
    | (if ($thread != null and ($owned | index($thread))) then "FOLLOW-UP"
       elif (.text | test($trig; "i")) then "NEW"
       else empty end) as $kind
    | "\($kind)\troom=\($room)\tseq=\(.seq)\tthread=\($thread // "-")\t@\(.handle)\t\(.ts/1000|strftime("%H:%M:%SZ"))\tatt=\(.attachments|length)\t\(.text[0:300]|gsub("\n";" "))"' <<<"$json"
  [ -z "$DRYRUN" ] && [ "$up" -gt "$since" ] 2>/dev/null && echo "$up" > "$seqf"
  return 0
}

# Writes to $D/.poll.out instead of stdout: the per-room failure counters must survive between polls,
# and a $(...) capture would run this in a subshell and reset them every time.
# Counters are plain variables named fails_<room> (macOS /bin/bash is 3.2: no associative arrays).
poll_all() {
  local room out n
  : > "$D/.poll.out"
  for room in $ROOMS; do
    if out=$(poll_room "$room"); then
      eval "fails_$room=0"; [ -n "$out" ] && printf '%s\n' "$out" >> "$D/.poll.out"
    else
      eval "n=\$(( \${fails_$room:-0} + 1 ))"; eval "fails_$room=$n"
      [ "$n" -ge 10 ] && echo "WATCHER-DOWN	room=$room	om room history failing 10 polls ($(date -u +%H:%M:%SZ))" >> "$D/.poll.out"
    fi
  done
}

if [ -n "$DRYRUN" ]; then poll_all; cat "$D/.poll.out"; exit 0; fi
while true; do
  poll_all; out=$(cat "$D/.poll.out")
  if [ -n "$out" ]; then
    grep -q '^WATCHER-DOWN' <<<"$out" && { echo "$out"; exit 1; }
    sleep 30; poll_all; more=$(cat "$D/.poll.out")
    printf '%s\n%s\n' "$out" "$more" | sed '/^$/d'; exit 0
  fi
  sleep 60
done
