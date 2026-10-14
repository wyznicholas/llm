#!/bin/bash
# Open a PR/MR for a routine's fix branch, on whichever forge the repo lives on.
#
# The target repos are split across two forges, so hardcoding either CLI breaks
# half the fleet:
#   openmarket (openmarket-internal)       -> github.com/openmarket-xyz   (gh)
#   openmarket-chat (since 2026-09-28), openmarket-chat-cloud, om-agent -> gitlab.com/openmarketxyz (glab)
#
# Always opens READY, never Draft: perf-sentinel's CI quarantines drafts, and a
# routine's whole point is producing something reviewable.
#
# Usage: routine-publish.sh --title T --body-file F [--repo DIR] [--base main]
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# GH_TOKEN must come from a file, not the keychain: under launchd (and any
# non-interactive ssh) ombot's login keychain is locked, so osxkeychain fails
# with -25308 and every GitHub fetch/push dies on "could not read Username".
# shellcheck source=/dev/null
[[ -r "$HOME/.config/om-routines/github.env" ]] && source "$HOME/.config/om-routines/github.env"


TITLE="" BODY_FILE="" REPO="$PWD" BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --title) TITLE="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$TITLE" ]] || { echo "routine-publish: --title required" >&2; exit 2; }
[[ -r "$BODY_FILE" ]] || { echo "routine-publish: --body-file must exist" >&2; exit 2; }

cd "$REPO"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REMOTE="$(git remote get-url origin)"

if [[ -z "$BASE" ]]; then
  BASE="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's#.*/##')"
  BASE="${BASE:-main}"
fi

# Refuse to publish an empty or default-branch change rather than opening noise.
if [[ "$BRANCH" == "$BASE" || "$BRANCH" == "HEAD" ]]; then
  echo "routine-publish: refusing to publish from '$BRANCH' (not a feature branch)" >&2
  exit 1
fi
if git diff --quiet "origin/$BASE...HEAD" 2>/dev/null; then
  echo "routine-publish: no changes vs origin/$BASE, nothing to publish" >&2
  exit 1
fi

# The body must carry its proof. A routine MR without a /verify block is exactly
# the unreviewable output that got earlier bots ignored.
if ! grep -q "/verify report" "$BODY_FILE"; then
  echo "routine-publish: body has no '/verify report' section — refusing to open" >&2
  exit 1
fi

git push -u origin "$BRANCH" --no-verify

case "$REMOTE" in
  *github.com*)
    URL=$(gh pr create --title "$TITLE" --body-file "$BODY_FILE" --base "$BASE" --head "$BRANCH")
    echo "$URL"
    NUM="${URL##*/}"
    sleep 5
    STATE=$(gh pr view "$NUM" --json mergeable,mergeStateStatus -q '.mergeable + " / " + .mergeStateStatus' 2>/dev/null || echo unknown)
    echo "merge-status: $STATE"
    [[ "$STATE" == CONFLICTING* ]] && echo "ACTION REQUIRED: rebase onto origin/$BASE and resolve before calling this done" >&2
    ;;
  *gitlab.com*|*kiyotaka.dev*)
    URL=$(glab mr create --title "$TITLE" --description "$(cat "$BODY_FILE")" \
          --target-branch "$BASE" --source-branch "$BRANCH" --yes 2>&1 | grep -Eo 'https://[^ ]+/merge_requests/[0-9]+' | tail -1)
    echo "${URL:-<mr url not parsed — check glab output>}"
    sleep 5
    STATE=$(glab mr view "$BRANCH" -F json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("detailed_merge_status") or d.get("merge_status","unknown"))' 2>/dev/null || echo unknown)
    echo "merge-status: $STATE"
    [[ "$STATE" == *conflict* ]] && echo "ACTION REQUIRED: rebase onto origin/$BASE and resolve before calling this done" >&2
    ;;
  *)
    echo "routine-publish: unrecognized forge for remote $REMOTE" >&2
    exit 1
    ;;
esac
