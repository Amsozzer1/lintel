import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { renderReportHuman } from "../../src/cli/format/human.ts";
import { finding, report } from "./helpers.ts";

const plain = stripVTControlCharacters;

describe("renderReportHuman", () => {
  it("lists tables P001 couldn't prove for lack of rows", () => {
    const r = report([finding({ fingerprint: "advisor:a" })]);
    r.probes.unverified = [{ schema: "public", name: "notes", reason: "no rows to probe" }];
    const out = plain(renderReportHuman(r));
    expect(out).toContain(
      "  -     public.notes P001 [unverified_no_rows]\n        anon can query it",
    );
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "1 findings (1 error, 0 warn, 0 info) · 1 unverified",
    );
  });
});
