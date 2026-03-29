#!/bin/bash
set -e

# Ensure current UID has a passwd entry (SSH refuses to run without one).
# /etc/passwd is made writable in the Dockerfile for this purpose.
if ! id -un 2>/dev/null; then
  echo "hostuser:x:$(id -u):$(id -g):Host User:/home/node:/bin/bash" >> /etc/passwd
fi

# Compile TypeScript agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Trust mounted repositories
git config --global --add safe.directory /workspace/extra/vault
git config --global --add safe.directory /workspace/extra/pantry

# Read input from stdin, run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
