import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contractFiles } from "../../src/core/contracts.ts";

describe("committed contract files", () => {
  it.each(Object.entries(contractFiles()))(
    "%s is up to date (run: pnpm gen)",
    async (path, content) => {
      const committed = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
      expect(committed).toBe(content);
    },
  );
});
