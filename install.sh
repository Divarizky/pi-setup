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

# Only these repository paths are deployed into the Pi agent directory.
PI_ITEMS=(AGENTS.md extensions prompts themes APPEND_SYSTEM.md SYSTEM.md node_modules)
# Skills go to the cross-tool Agent Skills location, not into AGENT_DIR.
# Only skills shipped by the repository are replaced; other skills there are kept.
SKILLS_DIR="$HOME/.agents/skills"
# Repository metadata and development/install files are never deployed.
CLEAN_ITEMS=(
  .git .github .gitignore README.md SETUP.md install.sh install.ps1
  package.json package-lock.json tsconfig.json
)
# These are local Pi state or locally installed tools. They are never replaced.
STATE_ITEMS=(
  auth.json settings.json trust.json models.json models-store.json usage-tracker.json
  mcp.json mcp-cache.json run-summaries.config.json sessions bin npm .pi
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

rm -rf "$STAGE_DIR/repo"
git clone --depth 1 "$REPO_URL" "$STAGE_DIR/repo"
(
  cd "$STAGE_DIR/repo"
  npm ci --ignore-scripts --no-audit --no-fund
)

if [[ "$REPAIR" == true && -e "$AGENT_DIR" ]]; then
  mkdir -p "$BACKUP_DIR"
  echo "Membuat backup ke: $BACKUP_DIR"
  for item in "${CLEAN_ITEMS[@]}" "${PI_ITEMS[@]}" "${STATE_ITEMS[@]}"; do
    source="$AGENT_DIR/$item"
    [[ -e "$source" || -L "$source" ]] || continue
    destination="$BACKUP_DIR/$item"
    mkdir -p "$(dirname "$destination")"
    cp -a "$source" "$destination"
  done
  # Lokasi skill lama, plus skill di tujuan baru yang akan diganti oleh repository.
  if [[ -e "$AGENT_DIR/skills" || -L "$AGENT_DIR/skills" ]]; then
    cp -a "$AGENT_DIR/skills" "$BACKUP_DIR/skills"
  fi
  for source in "$STAGE_DIR/repo/skills"/*; do
    [[ -e "$source" || -L "$source" ]] || continue
    target="$SKILLS_DIR/$(basename "$source")"
    [[ -e "$target" || -L "$target" ]] || continue
    mkdir -p "$BACKUP_DIR/agents-skills"
    cp -a "$target" "$BACKUP_DIR/agents-skills/$(basename "$source")"
  done
  printf '%s\n' "${CLEAN_ITEMS[@]}" > "$BACKUP_DIR/excluded-items.txt"
  printf '%s\n' "${PI_ITEMS[@]}" > "$BACKUP_DIR/pi-items.txt"
  printf '%s\n' "${STATE_ITEMS[@]}" > "$BACKUP_DIR/state-items.txt"

  for item in "${CLEAN_ITEMS[@]}"; do
    rm -rf "$AGENT_DIR/$item"
  done
  for item in "${PI_ITEMS[@]}"; do
    [[ -e "$STAGE_DIR/repo/$item" || -L "$STAGE_DIR/repo/$item" ]] && rm -rf "$AGENT_DIR/$item"
  done
fi

mkdir -p "$AGENT_DIR"
for item in "${PI_ITEMS[@]}"; do
  source="$STAGE_DIR/repo/$item"
  [[ -e "$source" || -L "$source" ]] || continue
  destination="$AGENT_DIR/$item"
  mkdir -p "$(dirname "$destination")"
  cp -a "$source" "$destination"
done

# Deploy skill repository ke SKILLS_DIR; skill lain di sana tidak disentuh.
mkdir -p "$SKILLS_DIR"
for source in "$STAGE_DIR/repo/skills"/*; do
  [[ -e "$source" || -L "$source" ]] || continue
  name="$(basename "$source")"
  rm -rf "${SKILLS_DIR:?}/$name"
  cp -a "$source" "$SKILLS_DIR/$name"
done

# Pindahkan skill lokal dari lokasi lama yang belum ada di tujuan (isinya sudah di-backup).
if [[ "$REPAIR" == true && -d "$AGENT_DIR/skills" ]]; then
  for item in "$AGENT_DIR/skills"/* "$AGENT_DIR/skills"/.[!.]*; do
    [[ -e "$item" || -L "$item" ]] || continue
    name="$(basename "$item")"
    [[ -e "$SKILLS_DIR/$name" || -L "$SKILLS_DIR/$name" ]] && continue
    cp -a "$item" "$SKILLS_DIR/$name"
  done
  rm -rf "$AGENT_DIR/skills"
fi

for item in extensions prompts node_modules; do
  [[ -e "$AGENT_DIR/$item" ]] || { echo "Instalasi tidak lengkap: $item tidak ditemukan." >&2; exit 1; }
done
[[ -d "$SKILLS_DIR" ]] || { echo "Instalasi tidak lengkap: $SKILLS_DIR tidak ditemukan." >&2; exit 1; }

if [[ "$REPAIR" == true ]]; then
  echo "Repair selesai. State pribadi tetap berada di $AGENT_DIR."
  echo "Backup tersedia di: $BACKUP_DIR"
else
  echo "Pi setup selesai."
fi
echo "Restart Pi untuk memuat extension dan skill."
