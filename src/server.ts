import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PensieveApi } from "./apiClient.js";
import { registerTools } from "./tools.js";

/**
 * Build a fresh MCP server instance with the read-only tool surface registered.
 * A new instance is created per request in the stateless Streamable HTTP transport.
 */
export function createServer(api: PensieveApi, opts: { name: string; version: string }): McpServer {
  const server = new McpServer(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );
  registerTools(server, api);
  return server;
}
