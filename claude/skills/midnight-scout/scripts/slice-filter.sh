#!/bin/bash
# Decide which candidate feature files are still un-audited.
#
# Input on stdin, one per line: "<filename>\t<the file's stamp line, or empty>".
# The calling phase does the READING (a shell script cannot reach ~/Documents
# from launchd); this script does the MATCHING, against the same constant the
# writer uses. That is the whole point — when the match lived in prose beside
# the writer's format, the two drifted and the burn-down silently stopped.
set -uo pipefail
. "$(dirname "$0")/audit-mark.sh"

while IFS=$'\t' read -r name stamp; do
  [[ -z "${name:-}" ]] && continue
  case "${stamp:-}" in
    *"$AUDIT_MARK"*) : ;;                      # audited — drop it
    *)               printf '%s\n' "$name" ;;  # no stamp — still fresh
  esac
done
