#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${PI_SETUP_REPO_URL:-https://github.com/Divarizky/pi-setup.git}"
# PI_CODING_AGENT_DIR is Pi's official override. Keep PI_AGENT_DIR for compatibility.
AGENT_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
REPAIR=false

usage() {
  cat <<'EOF'
Usage: install.sh [--repair]

  --repair  Backup the existing agent state, replace repository-managed files,
            and reinstall dependencies.

Environment:
  PI_CODING_AGENT_DIR  Pi agent directory override (preferred)
  PI_AGENT_DIR         Legacy override
  PI_SETUP_REPO_URL    Repository URL override
EOF
}

while (($#)); do
  case "$1" in
    --repair) REPAIR=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argumen tidak dikenal: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v git >/dev/null || { echo "Git tidak ditemukan." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm tidak ditemukan. Install Node.js LTS." >&2; exit 1; }

AGENT_EXISTS=false
[[ -e "$AGENT_DIR" ]] && AGENT_EXISTS=true
mkdir -p "$(dirname "$AGENT_DIR")"
AGENT_DIR="$(cd "$(dirname "$AGENT_DIR")" && pwd)/$(basename "$AGENT_DIR")"
PARENT_DIR="$(dirname "$AGENT_DIR")"
BACKUP_ROOT="$PARENT_DIR/pi-agent-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-setup.XXXXXX")"
cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

MANAGED_ITEMS=(
  .git .github .gitignore AGENTS.md README.md SETUP.md
  install.sh install.ps1 package.json package-lock.json tsconfig.json
  extensions skills prompts
)
# These are local Pi state or locally installed tools. They are never replaced.
STATE_ITEMS=(
  auth.json settings.json trust.json models.json models-store.json usage-tracker.json
  mcp.json mcp-cache.json sessions bin npm themes APPEND_SYSTEM.md SYSTEM.md
)

if [[ -d "$AGENT_DIR/.git" && "$REPAIR" == false ]]; then
  echo "Repository sudah ada: $AGENT_DIR"
  cd "$AGENT_DIR"
  npm ci --ignore-scripts --no-audit --no-fund
  echo "Pi setup selesai. Restart Pi untuk memuat extension dan skill."
  exit 0
fi

if [[ -e "$AGENT_DIR" && "$REPAIR" == false ]]; then
  echo "$AGENT_DIR sudah ada tetapi bukan repository Git." >&2
  echo "Jalankan ulang dengan --repair untuk backup dan sinkronisasi bersih." >&2
  exit 1
fi

if [[ "$REPAIR" == true && -e "$AGENT_DIR" ]]; then
  mkdir -p "$BACKUP_DIR"
  echo "Membuat backup ke: $BACKUP_DIR"
  for item in "${MANAGED_ITEMS[@]}" "${STATE_ITEMS[@]}"; do
    source="$AGENT_DIR/$item"
    [[ -e "$source" || -L "$source" ]] || continue
    destination="$BACKUP_DIR/$item"
    mkdir -p "$(dirname "$destination")"
    cp -a "$source" "$destination"
  done
  printf '%s\n' "${MANAGED_ITEMS[@]}" > "$BACKUP_DIR/managed-items.txt"
  printf '%s\n' "${STATE_ITEMS[@]}" > "$BACKUP_DIR/state-items.txt"

  for item in "${MANAGED_ITEMS[@]}"; do
    rm -rf "$AGENT_DIR/$item"
  done
fi

rm -rf "$STAGE_DIR/repo"
git clone --depth 1 "$REPO_URL" "$STAGE_DIR/repo"
mkdir -p "$AGENT_DIR"
cp -a "$STAGE_DIR/repo/." "$AGENT_DIR/"
cd "$AGENT_DIR"
npm ci --ignore-scripts --no-audit --no-fund

for item in extensions skills prompts; do
  [[ -d "$AGENT_DIR/$item" ]] || { echo "Instalasi tidak lengkap: $item tidak ditemukan." >&2; exit 1; }
done

if [[ "$REPAIR" == true ]]; then
  echo "Repair selesai. State pribadi tetap berada di $AGENT_DIR."
  echo "Backup tersedia di: $BACKUP_DIR"
else
  echo "Pi setup selesai."
fi
echo "Restart Pi untuk memuat extension dan skill."
