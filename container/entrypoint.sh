#!/bin/bash
set -e

# Compile TypeScript agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Configure git auth if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper "!f() { echo username=x-access-token; echo password=\$GITHUB_TOKEN; }; f"
  git config --global url."https://github.com/".insteadOf "git@github.com:"
fi

# Trust mounted repositories
git config --global --add safe.directory /workspace/extra/vault

# Read input from stdin, run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
