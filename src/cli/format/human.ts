import pc from "picocolors";
import type { Diff, Finding, Level, Report } from "../../core/findings.ts";
import { objectLabel } from "./markdown.ts";

const LEVEL_STYLE: Record<Level, (s: string) => string> = {
  error: (s) => pc.red(pc.bold(s)),
  warn: (s) => pc.yellow(s),
  info: (s) => pc.blue(s),
};

function findingLine(f: Finding): string {
  const proof = f.source === "probe" ? pc.magenta(" [proven]") : "";
  return `  ${LEVEL_STYLE[f.level](f.level.padEnd(5))} ${pc.bold(objectLabel(f))} ${pc.dim(f.rule)}${proof}\n        ${f.message}`;
}

function counts(findings: Finding[]): string {
  const by = (l: Level) => findings.filter((f) => f.level === l).length;
  return `${by("error")} error, ${by("warn")} warn, ${by("info")} info`;
}

export function renderReportHuman(report: Report): string {
  const lines = [pc.dim(`lintel ${report.lintel_version} · ${report.target.label}`), ""];
  for (const level of ["error", "warn", "info"] as const) {
    const group = report.findings.filter((f) => f.level === level);
    if (group.length) lines.push(...group.map(findingLine), "");
  }
  if (!report.findings.length) lines.push(pc.green("  no findings"), "");
  lines.push(`${report.findings.length} findings (${counts(report.findings)})`);
  return lines.join("\n");
}

export function renderDiffHuman(diff: Diff): string {
  const lines: string[] = [];
  if (diff.new.length) lines.push(pc.bold("New"), ...diff.new.map(findingLine), "");
  if (diff.resolved.length) lines.push(pc.bold("Resolved"), ...diff.resolved.map(findingLine), "");
  lines.push(
    `${diff.new.length} new (${counts(diff.new)}) · ${diff.resolved.length} resolved · ${diff.unchanged.length} unchanged`,
  );
  return lines.join("\n");
}
