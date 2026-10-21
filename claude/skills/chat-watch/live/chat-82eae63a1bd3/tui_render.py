# ANSI capture (tmux capture-pane -e) -> standalone dark HTML page.
import sys
from rich.console import Console
from rich.text import Text
from rich.terminal_theme import TerminalTheme

# Dark default fg/bg so 'default colour' cells don't render white.
DARK = TerminalTheme((13, 15, 18), (214, 214, 214), [(0,0,0),(205,49,49),(13,188,121),(229,229,16),(36,114,200),(188,63,188),(17,168,205),(229,229,229)], [(102,102,102),(241,76,76),(35,209,139),(245,245,67),(59,142,234),(214,112,214),(41,184,219),(255,255,255)])

src, dst = sys.argv[1], sys.argv[2]
raw = open(src, encoding="utf-8", errors="replace").read()
width = max((len(Text.from_ansi(line).plain) for line in raw.splitlines()), default=80)
console = Console(record=True, width=max(width, 40), color_system="truecolor", file=open("/dev/null", "w"))
console.print(Text.from_ansi(raw), end="", soft_wrap=True)
html = console.export_html(theme=DARK, inline_styles=True, code_format=(
    "<!doctype html><html><head><meta charset='utf-8'><style>"
    "body{{margin:0;background:#0d0f12;color:#d6d6d6}}"
    "pre{{margin:0;padding:12px;font:13px/1.25 'DejaVu Sans Mono','Liberation Mono',monospace;"
    "display:inline-block}}</style></head><body><pre>{code}</pre></body></html>"))
open(dst, "w", encoding="utf-8").write(html)
