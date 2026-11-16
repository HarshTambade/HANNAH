import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHANNAHMcpServer } from "./mcp-core.mjs";

Promise.resolve().then(() => serveStdio(createHANNAHMcpServer)).catch((error) => {
  // SDK request errors can carry headers/configuration; log only the safe class name.
  const errorName = error instanceof Error ? error.name : "unknown error";
  console.error(`HANNAH MCP stdio server stopped (${errorName}).`);
  process.exitCode = 1;
});
