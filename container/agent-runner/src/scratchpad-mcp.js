#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.FEED_API_URL || "https://feed-api.ndonohue.workers.dev";
const API_TOKEN = process.env.FEED_API_TOKEN;

if (!API_TOKEN) {
  console.error("[scratchpad-mcp] WARNING: FEED_API_TOKEN not set — scratchpad tools will return errors");
}

const headers = API_TOKEN
  ? { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" }
  : { "Content-Type": "application/json" };

function requireToken() {
  if (!API_TOKEN) {
    return {
      content: [{ type: "text", text: "ERROR: FEED_API_TOKEN not configured. Scratchpad unavailable." }],
      isError: true,
    };
  }
  return null;
}

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { headers, ...options });
    if (!res.ok) {
      const text = await res.text();
      return {
        content: [{ type: "text", text: `ERROR: ${res.status} ${res.statusText} — ${text}` }],
        isError: true,
      };
    }
    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `ERROR: ${err.message}` }],
      isError: true,
    };
  }
}

const server = new McpServer({
  name: "feed-scratchpad",
  version: "1.0.0",
});

server.tool(
  "read_scratchpad",
  "Read the current scratchpad contents. Returns the markdown body, who last edited it, and when.",
  {},
  async () => {
    const err = requireToken();
    if (err) return err;
    return safeFetch(`${API_URL}/scratchpad`);
  }
);

server.tool(
  "write_scratchpad",
  "Replace the entire scratchpad body with new content. Use for full rewrites or clearing. Logs the previous version automatically.",
  { body: z.string().describe("The new markdown body"), author: z.string().optional().describe("Who is writing (default: lemon-chan)") },
  async ({ body, author }) => {
    const err = requireToken();
    if (err) return err;
    return safeFetch(`${API_URL}/scratchpad`, {
      method: "PUT",
      body: JSON.stringify({ body, author: author || "lemon-chan" }),
    });
  }
);

server.tool(
  "append_scratchpad",
  "Append text to the scratchpad without overwriting existing content. Use for adding todo items, notes, or status updates. Automatically adds a newline separator.",
  { append: z.string().describe("Text to append"), author: z.string().optional().describe("Who is appending (default: lemon-chan)") },
  async ({ append, author }) => {
    const err = requireToken();
    if (err) return err;
    return safeFetch(`${API_URL}/scratchpad`, {
      method: "PATCH",
      body: JSON.stringify({ append, author: author || "lemon-chan" }),
    });
  }
);

server.tool(
  "scratchpad_log",
  "Get the change history of the scratchpad. Each entry shows a previous version of the body, who wrote it, and when.",
  { limit: z.number().optional().describe("Max entries to return (default 10)") },
  async ({ limit }) => {
    const err = requireToken();
    if (err) return err;
    return safeFetch(`${API_URL}/scratchpad/log?limit=${limit || 10}`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
