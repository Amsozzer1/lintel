import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { renderReportHuman } from "../../src/cli/format/human.ts";
import { Engine } from "../src/engine.ts";
import { EXAMPLES } from "../src/examples.ts";
import { lineText, reportLines } from "../src/render.ts";
import { nodeAssets } from "./node-assets.ts";

const plain = stripVTControlCharacters;
const engine = new Engine(nodeAssets);
beforeAll(() => engine.warmUp(), 120_000);

describe("playground output is the CLI's human report", () => {
  const cases = [
    ...EXAMPLES.map((e) => [e.label, e.migration, e.seed] as const),
    ["an empty table", "create table public.notes (id int primary key);", ""] as const,
  ];
  it.each(cases)("%s", async (_label, migration, seed) => {
    const o = await engine.run(migration, seed);
    if (!o.ok) throw new Error(o.error.message);
    expect(lineText(reportLines(o.report))).toBe(plain(renderReportHuman(o.report)));
  });
});
