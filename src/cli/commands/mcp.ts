import { loadConfig } from "../../core/config.ts";
import { ExitCode } from "../../core/errors.ts";

/** Serve MCP over stdio until the client disconnects, then exit cleanly. */
export async function run(opts: { config?: string }): Promise<number> {
  const { serveStdio } = await import("../../mcp/server.ts");
  await serveStdio(await loadConfig(opts.config));
  return ExitCode.ok;
}
