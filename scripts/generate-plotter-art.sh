#!/usr/bin/env bash
# generate-plotter-art.sh — Guard script for scheduled plotter art generation
#
# Runs before Lemon Chan wakes. Checks if feed queue needs new items,
# reads preference model, calls Ollama to generate a creative brief,
# then outputs the brief for the agent to use with feed-push.
#
# Output: JSON { "wakeAgent": bool, "data": { "brief": string, "stats": object } }
#
# Used as a NanoClaw scheduled task guard script.

set -euo pipefail

HATCH3D_DIR="/workspace/extra/hatch3d"
MODEL_PATH="$HATCH3D_DIR/data/preferences/model.json"
OBS_PATH="$HATCH3D_DIR/data/preferences/observations.jsonl"
OLLAMA_HOST="${OLLAMA_HOST:-host.docker.internal:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
FEED_API_URL="${FEED_API_URL:-https://feed-api.ndonohue.workers.dev}"

# Check feed queue — skip if plenty of unreviewed items
if [ -n "${FEED_API_TOKEN:-}" ]; then
  PENDING=$(curl -sf -H "Authorization: Bearer $FEED_API_TOKEN" \
    "$FEED_API_URL/items?source=hatch3d&status=pending&limit=1" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total',0))" 2>/dev/null || echo "0")

  if [ "$PENDING" -ge 5 ]; then
    echo '{"wakeAgent": false, "data": {"reason": "feed queue has '"$PENDING"' pending items"}}'
    exit 0
  fi
fi

# Build preference summary for Ollama
PREF_SUMMARY=""
if [ -f "$MODEL_PATH" ]; then
  PREF_SUMMARY=$(python3 -c "
import json, sys

model = json.load(open('$MODEL_PATH'))

# Top compositions by score
comps = sorted(model.get('compositionScores', {}).items(), key=lambda x: x[1]['score'], reverse=True)
top = [f'{c[0]} ({c[1][\"score\"]:.2f}, {c[1][\"accepted\"]}/{c[1][\"total\"]})' for c in comps[:5]]
bottom = [f'{c[0]} ({c[1][\"score\"]:.2f})' for c in comps[-3:]]

# Top tags
tags = sorted(model.get('tagScores', {}).items(), key=lambda x: x[1]['score'], reverse=True)
liked_tags = [t[0] for t in tags[:8] if t[1]['score'] > 0.5]
disliked_tags = [t[0] for t in tags if t[1]['score'] < 0.4][:5]

# Recent observation count
obs_count = model.get('observationCount', 0)

print(f'Observations: {obs_count}')
print(f'Liked compositions: {\", \".join(top)}')
print(f'Avoided compositions: {\", \".join(bottom)}')
print(f'Liked tags: {\", \".join(liked_tags)}')
print(f'Disliked tags: {\", \".join(disliked_tags)}')
" 2>/dev/null || echo "No preference data available")
fi

# Count recent compositions to detect repetition
RECENT_COMPS=""
if [ -f "$OBS_PATH" ]; then
  RECENT_COMPS=$(tail -20 "$OBS_PATH" 2>/dev/null | python3 -c "
import sys, json, collections
comps = collections.Counter()
for line in sys.stdin:
    try:
        o = json.loads(line)
        comps[o['composition']] += 1
    except: pass
print(', '.join(f'{c}: {n}' for c, n in comps.most_common(5)))
" 2>/dev/null || echo "")
fi

# Generate brief via Ollama
PROMPT="You are an art director for a plotter art generation system. Generate a short creative brief (1-2 sentences) to guide today's batch of plotter art compositions.

The brief should describe an aesthetic direction using words like: sparse, dense, organic, geometric, flowing, crystalline, chaotic, minimal, bold, elegant, intricate, mathematical, turbulent, architectural, scientific, layered, etc.

Current taste profile:
$PREF_SUMMARY

Recent compositions generated: $RECENT_COMPS

Guidelines:
- If recent compositions are repetitive, push in a NEW direction
- Mix familiar liked styles with something unexpected
- Be specific enough to guide composition selection
- Output ONLY the brief text, nothing else"

BRIEF=$(curl -sf "http://$OLLAMA_HOST/api/generate" \
  -d "$(python3 -c "
import json
print(json.dumps({
    'model': '$OLLAMA_MODEL',
    'prompt': '''$PROMPT''',
    'stream': False,
    'options': {'temperature': 0.9, 'num_predict': 80}
}))
")" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','').strip())" 2>/dev/null || echo "")

# Fallback: generate a brief from preference data without LLM
if [ -z "$BRIEF" ]; then
  BRIEF="surprise me with something bold and different"
fi

# Output for NanoClaw scheduler
python3 -c "
import json
print(json.dumps({
    'wakeAgent': True,
    'data': {
        'brief': '''$BRIEF''',
        'pending_items': int('${PENDING:-0}'),
        'pref_summary': '''$PREF_SUMMARY'''
    }
}))
"
