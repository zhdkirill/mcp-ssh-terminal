#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "./manager.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const manager = new SessionManager();
  const server = createServer(manager);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    manager.closeAll(250);
    // Exit only after the SIGKILL escalation inside closeAll has had a
    // chance to run, so stubborn children aren't orphaned.
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // When the MCP client disconnects, shut down too — live PTY children would
  // otherwise keep this process (and its ssh sessions) running forever. The
  // SDK's stdio transport only watches stdin 'data'/'error' (onclose fires
  // solely on explicit close), so watch stdin EOF ourselves as well.
  server.server.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  // IMPORTANT: stdout is the MCP protocol channel. Never write logs there.
  console.error("mcp-ssh server started (stdio).");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
