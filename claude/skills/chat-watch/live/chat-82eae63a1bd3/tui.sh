#!/usr/bin/env bash
# Run the om TUI from a monorepo checkout/worktree inside a detached tmux
# session and capture it as text and as a PNG. See ENV.md beside this.
#
#   tui.sh start <openmarket-worktree> <slot-port> [cols] [rows] [-- extra om args]
#                 # slot-port picks OM_HOME ~/.openmarket-chatdev-<port> (start the
#                 # GUI daemon on that port first so the TUI shows "om running")
#   tui.sh keys  <slot-port> <tmux send-keys args...>   e.g. tui.sh keys 31470 '/help' Enter
#   tui.sh shot  <slot-port> <out-prefix>   # <out>.txt (plain) + <out>.ansi + <out>.png
#   tui.sh stop  <slot-port>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_DIR="$HOME/.local/opt/bun-1.4.3"
die() { echo "tui.sh: $*" >&2; exit 1; }
sock() { echo "omtui-$1"; }

case "${1:-}" in
  start)
    wt="$(cd "${2:?openmarket worktree}" && pwd)"; port="${3:?slot port}"; cols="${4:-160}"; rows="${5:-48}"
    shift $(( $# >= 5 ? 5 : $# )); [[ "${1:-}" == "--" ]] && shift
    home="$HOME/.openmarket-chatdev-$port"
    [[ -d "$home" ]] || die "$home missing: run 'gui.sh start <chat-worktree> $port' once first"
    [[ -f "$wt/packages/cli/src/bootstrap.ts" ]] || die "$wt is not an openmarket monorepo checkout"
    # A fresh monorepo worktree has no apps/dashboard/dist; the CLI imports it
    # at load and dies "Cannot find module .../app.css". Write the stubs.
    [[ -f "$wt/apps/dashboard/dist/assets/app.js" ]] || ( cd "$wt" && PATH="$BUN_DIR:$PATH" bun run scripts/ensure-dashboard-dist.ts >/dev/null )
    tmux -L "$(sock "$port")" kill-server 2>/dev/null || true
    # The keyless openai-compatible pair satisfies the "needs an LLM" gate so
    # the terminal opens instead of the om init walk; turns that call the model
    # fail (nothing listens on :9). Unset both to test real agent turns.
    tmux -L "$(sock "$port")" new-session -d -s tui -x "$cols" -y "$rows" \
      "cd '$wt' && PATH='$BUN_DIR':\$PATH OM_HOME='$home' OM_BIND=127.0.0.1:$port OM_NO_UPDATE_CHECK=1 OM_NO_BROWSER=1 OPENMARKET_LLM_PROVIDER=openai-compatible OPENMARKET_LLM_BASE_URL=http://127.0.0.1:9/v1 TERM=xterm-256color COLORTERM=truecolor '$BUN_DIR/bun' packages/cli/src/bootstrap.ts chat $*; echo '[om exited]'; sleep 600"
    sleep 10
    tmux -L "$(sock "$port")" capture-pane -p -t tui | grep -v '^\s*$' | head -12
    ;;
  keys)
    port="${2:?slot port}"; shift 2
    tmux -L "$(sock "$port")" send-keys -t tui "$@"
    ;;
  shot)
    port="${2:?slot port}"; out="${3:?out prefix}"; out="$(realpath -m "$out")"
    tmux -L "$(sock "$port")" capture-pane -p -t tui > "$out.txt"
    tmux -L "$(sock "$port")" capture-pane -p -e -t tui > "$out.ansi"
    python3 -I "$HERE/tui_render.py" "$out.ansi" "$out.html"
    node "$HERE/shot.mjs" --page "file://$out.html" "$out"
    echo "$out.txt $out.png"
    ;;
  stop)
    port="${2:?slot port}"
    tmux -L "$(sock "$port")" kill-server 2>/dev/null && echo "tui :$port stopped" || echo "no tui on :$port"
    ;;
  *) sed -n 2,14p "$0"; exit 2 ;;
esac
