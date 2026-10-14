#!/bin/bash
# Print the audit stamp block for a feature file. The CALLING PHASE writes it
# into the file — this script never touches ~/Documents (unreachable from
# launchd by any shell).
#
# usage: stamp.sh <date> <bundle> <commit> <audit-note-wikilink> <n-findings>
set -uo pipefail
. "$(dirname "$0")/audit-mark.sh"

d="${1:?date}"; bundle="${2:?bundle}"; commit="${3:?commit}"
note="${4:?audit note wikilink}"; n="${5:?finding count}"

printf '\n---\n\n%s%s by midnight-scout — bundle `%s`, source `%s`. Audit note: %s. %s findings filed.\n' \
  "$AUDIT_MARK" "$d" "$bundle" "$commit" "$note" "$n"
