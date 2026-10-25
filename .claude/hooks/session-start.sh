#!/bin/bash
# Make Node 24 the default in Claude Code cloud sessions.
# The container ships Node 22, but package.json requires ^24.13.1.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export NVM_DIR="${NVM_DIR:-/opt/nvm}"
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"

# Installs only when missing; nvm skips versions already present.
nvm install 24 >&2
nvm alias default 24 >/dev/null

NODE24_BIN="$(dirname "$(nvm which 24)")"

# Put Node 24 ahead of /opt/node22 for every shell in this session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$NODE24_BIN:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
