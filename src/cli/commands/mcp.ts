import { loadConfig } from "../../core/config.ts";

/** Serve MCP over stdio until the client disconnects. */
export async function run(opts: { config?: string }): Promise<number> {
  const { serveStdio } = await import("../../mcp/server.ts");
  await serveStdio(await loadConfig(opts.config));
  // Keep the process alive; the transport ends it when stdin closes.
  return new Promise<number>(() => {});
}
