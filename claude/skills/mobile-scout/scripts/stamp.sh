#!/bin/bash
# Print the audit stamp block for a MOBILE feature file. The calling phase
# writes it into the file; this script never touches ~/Documents (bash under
# launchd cannot read it — see reference_launchd_tcc_documents).
#
# The marker comes from midnight-scout's audit-mark.sh (symlinked, not copied):
# slice-filter.sh matches on it, and a second copy is how the writer and the
# reader drifted apart once already.
#
# usage: stamp.sh <date> <js-commit> <native-build> <audit-note-wikilink> <n-findings>
set -uo pipefail
. "$(dirname "$0")/audit-mark.sh"

d="${1:?date}"; js="${2:?js commit}"; native="${3:?native build}"
note="${4:?audit note wikilink}"; n="${5:?finding count}"

printf '\n---\n\n%s%s by mobile-scout — iOS simulator, JS `%s`, native `%s`. Audit note: %s. %s findings filed.\n' \
  "$AUDIT_MARK" "$d" "$js" "$native" "$note" "$n"
