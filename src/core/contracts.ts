import { z } from "zod";
import { Diff, Report } from "./findings.ts";

/** Public, versioned contracts that are committed to the repo and checked for drift. */
export function contractFiles(): Record<string, string> {
  const schema = (s: z.ZodType, id: string) =>
    `${JSON.stringify({ $id: `https://github.com/Amsozzer1/lintel/schemas/${id}`, ...z.toJSONSchema(s, { target: "draft-2020-12" }) }, null, 2)}\n`;
  return {
    "schemas/findings.v1.json": schema(Report, "findings.v1.json"),
    "schemas/diff.v1.json": schema(Diff, "diff.v1.json"),
  };
}
