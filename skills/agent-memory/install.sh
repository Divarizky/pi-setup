#!/bin/sh
# Install agent-memory di perangkat baru (macOS/Linux).
# Syarat: python3. Vault terdeteksi otomatis dari Google Drive,
# atau set AGENT_MEMORY_VAULT="..." di shell rc.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
SKILLS="$HOME/.agents/skills"

mkdir -p "$SKILLS" "$HOME/.local/bin"
link() {  # link <src> <dst>: lewati bila src sudah sama dengan dst (source = folder skill itu sendiri)
  [ "$(realpath "$1" 2>/dev/null)" = "$(realpath "$2" 2>/dev/null)" ] && { echo "OK $2 (sudah source)"; return; }
  ln -sfn "$1" "$2" && echo "OK $2"
}
link "$SRC" "$SKILLS/agent-memory"
link "$SRC/bin/memory" "$HOME/.local/bin/memory"
[ -d "$HOME/.claude/skills" ] && link "$SRC" "$HOME/.claude/skills/agent-memory" || true
[ -d "$HOME/.codex/skills" ] && link "$SRC" "$HOME/.codex/skills/agent-memory" || true

# Hook SessionStart (read-only brief) untuk Claude dan Codex, merge tanpa menghapus yang ada.
python3 - "$SRC" <<'EOF'
import json, shutil, sys
from pathlib import Path
SRC = Path(sys.argv[1])
ENTRY = {"type": "command", "command": "memory brief --max-tokens 300", "timeout": 15}
def merge(path):
    p = Path(path).expanduser()
    if p.exists():
        bak = p.with_name(f"{p.stem}.bak-install{p.suffix}")
        if not bak.exists(): shutil.copy2(p, bak)
        try: d = json.loads(p.read_text())
        except json.JSONDecodeError: print(f"SKIP {p}: JSON tidak valid"); return
    else:
        d = {}
    hooks = d.setdefault("hooks", {})
    lst = [e for e in hooks.get("SessionStart", []) if "memory brief" not in json.dumps(e)]
    lst.append({"hooks": [ENTRY]})
    hooks["SessionStart"] = lst
    p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
    print(f"OK {p}")
merge("~/.claude/settings.json")
merge("~/.codex/hooks.json")
EOF

# Extension Pi (brief otomatis): salin bila folder extensions Pi ada di device ini.
if [ -d "$HOME/.pi/agent/extensions" ]; then
  cp "$SRC/pi-extension/agent-memory.ts" "$HOME/.pi/agent/extensions/agent-memory.ts" && echo "OK extension Pi"
fi

echo "---"
if "$HOME/.local/bin/memory" status 2>/dev/null || python3 "$SRC/memory.py" status; then
  :
else
  echo "Vault tidak ketemu. Set AGENT_MEMORY_VAULT=<path vault> di shell rc."
  echo "Linux tanpa Google Drive resmi: mount Drive (mis. rclone) lalu arahkan AGENT_MEMORY_VAULT ke sana."
fi
echo "Pastikan ~/.local/bin ada di PATH. Untuk Pi, restart agar extension agent-memory.ts dimuat."
