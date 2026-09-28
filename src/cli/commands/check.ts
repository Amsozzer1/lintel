import { runChecks } from "../../core/check.ts";
import { ExitCode } from "../../core/errors.ts";
import { atOrAbove } from "../../core/findings.ts";
import { renderReportHuman } from "../format/human.ts";
import { out } from "../io.ts";
import { dbLabel, parseFailOn, parseFormat, resolveDb } from "../options.ts";

export interface CheckOptions {
  db?: string;
  format?: string;
  failOn?: string;
}

export async function run(opts: CheckOptions): Promise<number> {
  const format = parseFormat(opts.format, ["human", "json"]);
  const failOn = parseFailOn(opts.failOn);
  const url = resolveDb(opts.db);
  const report = await runChecks(url, { label: dbLabel(url) });
  out(format === "json" ? JSON.stringify(report, null, 2) : renderReportHuman(report));
  return atOrAbove(report.findings, failOn).length ? ExitCode.findings : ExitCode.ok;
}
