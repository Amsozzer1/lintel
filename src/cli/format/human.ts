import pc from "picocolors";
import type { Diff, Finding, Level, Report } from "../../core/findings.ts";
import { levelCounts, objectLabel, unverifiedExplanation } from "../../core/report-text.ts";

const LEVEL_STYLE: Record<Level, (s: string) => string> = {
  error: (s) => pc.red(pc.bold(s)),
  warn: (s) => pc.yellow(s),
  info: (s) => pc.blue(s),
};

function findingLine(f: Finding): string {
  const proof = f.source === "probe" ? pc.magenta(" [proven]") : "";
  return `  ${LEVEL_STYLE[f.level](f.level.padEnd(5))} ${pc.bold(objectLabel(f))} ${pc.dim(f.rule)}${proof}\n        ${f.message}`;
}

/** An exposed relation P001 couldn't prove either way, e.g. an empty table. */
function unverifiedLine(u: { schema: string; name: string; reason: string }): string {
  return `  ${pc.dim("-".padEnd(5))} ${pc.bold(`${u.schema}.${u.name}`)} ${pc.dim("P001")}${pc.dim(" [unverified_no_rows]")}\n        ${unverifiedExplanation(u.reason)}`;
}

export function renderReportHuman(report: Report): string {
  const lines = [pc.dim(`lintel ${report.lintel_version} · ${report.target.label}`), ""];
  for (const level of ["error", "warn", "info"] as const) {
    const group = report.findings.filter((f) => f.level === level);
    if (group.length) lines.push(...group.map(findingLine), "");
  }
  if (!report.findings.length) lines.push(pc.green("  no findings"), "");
  const unverified = report.probes.unverified ?? [];
  if (unverified.length) lines.push(...unverified.map(unverifiedLine), "");
  lines.push(
    `${report.findings.length} findings (${levelCounts(report.findings)})${unverified.length ? ` · ${unverified.length} unverified` : ""}`,
  );
  return lines.join("\n");
}

export function renderDiffHuman(diff: Diff): string {
  const lines: string[] = [];
  if (diff.new.length) lines.push(pc.bold("New"), ...diff.new.map(findingLine), "");
  if (diff.resolved.length) lines.push(pc.bold("Resolved"), ...diff.resolved.map(findingLine), "");
  lines.push(
    `${diff.new.length} new (${levelCounts(diff.new)}) · ${diff.resolved.length} resolved · ${diff.unchanged.length} unchanged`,
  );
  return lines.join("\n");
}
