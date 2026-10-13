/** Wording shared by every surface that prints findings: the CLI and the playground. */
import type { Finding, Level } from "./findings.ts";

export function objectLabel(f: Finding): string {
  const { schema, name } = f.object;
  return [schema, name].filter(Boolean).join(".") || "(database)";
}

export function levelCounts(findings: Finding[]): string {
  const by = (l: Level) => findings.filter((f) => f.level === l).length;
  return `${by("error")} error, ${by("warn")} warn, ${by("info")} info`;
}

/** Why P001 couldn't prove an exposed relation either way. */
export function unverifiedExplanation(reason: string): string {
  return reason === "no rows to probe"
    ? "anon can query it, but it has no rows, so P001 can't prove whether RLS hides them. Add rows to seed.sql."
    : reason;
}
