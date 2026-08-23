#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${PI_SETUP_REPO_URL:-https://github.com/Divarizky/pi-setup.git}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

command -v git >/dev/null || { echo "Git tidak ditemukan." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm tidak ditemukan. Install Node.js LTS." >&2; exit 1; }

mkdir -p "$(dirname "$AGENT_DIR")"
if [[ -d "$AGENT_DIR/.git" ]]; then
  echo "Repository sudah ada: $AGENT_DIR"
elif [[ -e "$AGENT_DIR" ]]; then
  echo "$AGENT_DIR sudah ada tetapi bukan repository Git. Backup/pindahkan dulu." >&2
  exit 1
else
  git clone "$REPO_URL" "$AGENT_DIR"
fi

cd "$AGENT_DIR"
npm ci
echo "Pi setup selesai. Restart Pi untuk memuat extension dan skill."
