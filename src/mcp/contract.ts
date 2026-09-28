import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Config } from "../core/config.ts";
import { createServer } from "./server.ts";

/** The tool list as clients see it. Committed as schemas/mcp-tools.v1.json and drift-tested. */
export async function mcpToolsContract(): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(Config.parse({}));
  const client = new Client({ name: "contract", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return `${JSON.stringify({ schema: "lintel.mcp-tools/v1", tools }, null, 2)}\n`;
}
