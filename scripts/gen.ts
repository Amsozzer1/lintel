/** Regenerate committed contract files. CI's drift test fails if they are stale. */
import { writeFile } from "node:fs/promises";
import { contractFiles } from "../src/core/contracts.ts";

for (const [path, content] of Object.entries(contractFiles())) {
  await writeFile(new URL(`../${path}`, import.meta.url), content);
  console.log(`wrote ${path}`);
}
