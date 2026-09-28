/** Regenerate committed contract files. CI's drift tests fail if they are stale. */
import { writeFile } from "node:fs/promises";
import { contractFiles } from "../src/core/contracts.ts";
import { mcpToolsContract } from "../src/mcp/contract.ts";

const files = { ...contractFiles(), "schemas/mcp-tools.v1.json": await mcpToolsContract() };
for (const [path, content] of Object.entries(files)) {
  await writeFile(new URL(`../${path}`, import.meta.url), content);
  console.log(`wrote ${path}`);
}
