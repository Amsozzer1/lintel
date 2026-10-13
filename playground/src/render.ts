/**
 * The CLI's human report (src/cli/format/human.ts) as styled lines instead of ANSI codes:
 * same lines, same words, same order. test/render.test.ts holds the two to each other.
 */
import type { Finding, Level, Report } from "../../src/core/findings.ts";
import { levelCounts, objectLabel, unverifiedExplanation } from "../../src/core/report-text.ts";

export type Tone = Level | "object" | "rule" | "proven" | "meta" | "text" | "clean";
export interface Span {
  text: string;
  tone: Tone;
}
/** One line of output; an empty line is a gap. */
export type Line = Span[];

const s = (text: string, tone: Tone = "text"): Span => ({ text, tone });

function finding(f: Finding): Line[] {
  return [
    [
      s("  "),
      s(f.level.padEnd(5), f.level),
      s(" "),
      s(objectLabel(f), "object"),
      s(" "),
      s(f.rule, "rule"),
      ...(f.source === "probe" ? [s(" [proven]", "proven")] : []),
    ],
    [s("        "), s(f.message)],
  ];
}

export function reportLines(report: Report): Line[] {
  const lines: Line[] = [
    [s(`lintel ${report.lintel_version} · ${report.target.label}`, "meta")],
    [],
  ];
  for (const level of ["error", "warn", "info"] as const) {
    const group = report.findings.filter((f) => f.level === level);
    if (group.length) lines.push(...group.flatMap(finding), []);
  }
  if (!report.findings.length) lines.push([s("  no findings", "clean")], []);
  const unverified = report.probes.unverified ?? [];
  for (const u of unverified)
    lines.push(
      [
        s("  "),
        s("-".padEnd(5), "meta"),
        s(" "),
        s(`${u.schema}.${u.name}`, "object"),
        s(" "),
        s("P001", "rule"),
        s(" [unverified_no_rows]", "meta"),
      ],
      [s("        "), s(unverifiedExplanation(u.reason))],
    );
  if (unverified.length) lines.push([]);
  lines.push([
    s(
      `${report.findings.length} findings (${levelCounts(report.findings)})${unverified.length ? ` · ${unverified.length} unverified` : ""}`,
      "meta",
    ),
  ]);
  return lines;
}

export const lineText = (lines: Line[]) =>
  lines.map((l) => l.map((x) => x.text).join("")).join("\n");
