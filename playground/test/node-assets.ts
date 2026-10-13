/** The engine's assets from node_modules, for running it under Node in tests. */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Assets } from "../src/engine.ts";

const require = createRequire(import.meta.url);
const pgliteDist = dirname(require.resolve("@electric-sql/pglite"));
const vectorDist = dirname(require.resolve("@electric-sql/pglite-pgvector"));
const dirOf = (file: string) => (file === "vector.tar.gz" ? vectorDist : pgliteDist);

export const nodeAssets: Assets = {
  native: [
    ...readdirSync(pgliteDist)
      .filter((f) => f.endsWith(".tar.gz"))
      .map((f) => f.replace(/\.tar\.gz$/, "")),
    "vector",
  ],
  url: (file) => pathToFileURL(join(dirOf(file), file)),
  load: async (file) => {
    const b = await readFile(join(pgliteDist, file));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
};
