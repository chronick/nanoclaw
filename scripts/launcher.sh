#!/bin/bash
# NanoClaw launcher — sources secrets from shared .env before starting.
# Used by com.nanoclaw launchd plist so secrets aren't in the plist itself.

set -euo pipefail

ENV_FILE="$HOME/.config/skiff/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

exec /Users/hooligansmcgee/.nvm/versions/node/v22.14.0/bin/node \
  /Users/hooligansmcgee/git/nanoclaw/dist/index.js
