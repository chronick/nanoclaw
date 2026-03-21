---
name: usage
description: Check token usage, costs, and API stats from Lookout. Use when asked about costs, spending, token usage, how much things cost, or usage statistics.
allowed-tools: Bash(curl:*)
---

# Usage Stats (Lookout)

Query the Lookout observability dashboard for token and cost data.

## API

Base URL: `http://host.docker.internal:4320`

| Endpoint | What it shows |
|----------|---------------|
| `/` | Dashboard overview (totals, cost, model/agent breakdown) |
| `/traces` | All trace spans |
| `/sessions` | Agent sessions |
| `/metrics` | Metrics |

## How to query

Fetch the dashboard and extract stats:

```bash
curl -s http://host.docker.internal:4320/
```

Parse the returned HTML for:
- Total spans and AI spans
- Total cost
- Model breakdown (which models, how many calls, cost per model)
- Agent breakdown (which agents, call counts)

Use `grep`, `sed`, or `awk` to pull numbers from the HTML. Don't install additional tools.

## Response format

Keep it short. Format for Telegram:

```
*Usage Stats*

Total cost: $X.XX
AI spans: N of M total

*By Model*
- claude-sonnet-4-20250514: N calls, $X.XX
- ...

*By Agent*
- agent-name: N calls
- ...
```

No markdown headers (#). Use *bold* for section labels. Bullets for lists. One fetch is usually enough -- don't over-query.
