import { readFile } from "node:fs/promises";
import { diffReports } from "../../core/diff.ts";
import { ExitCode, LintelError } from "../../core/errors.ts";
import { atOrAbove, Report } from "../../core/findings.ts";
import { renderDiffHuman } from "../format/human.ts";
import { decodeState, renderDiffMarkdown } from "../format/markdown.ts";
import { out } from "../io.ts";
import { parseFailOn, parseFormat } from "../options.ts";

export interface DiffOptions {
  format?: string;
  failOn?: string;
  previousComment?: string;
}

export async function run(basePath: string, headPath: string, opts: DiffOptions): Promise<number> {
  const format = parseFormat(opts.format);
  const failOn = parseFailOn(opts.failOn);
  const [base, head] = await Promise.all([readReport(basePath), readReport(headPath)]);
  const diff = diffReports(base, head);
  if (format === "json") out(JSON.stringify(diff, null, 2));
  else if (format === "markdown") {
    const previous = opts.previousComment
      ? decodeState(await readFile(opts.previousComment, "utf8"))
      : undefined;
    out(
      renderDiffMarkdown(diff, {
        failOn,
        baseLabel: base.target.label,
        headLabel: head.target.label,
        previous,
      }),
    );
  } else out(renderDiffHuman(diff));
  return atOrAbove(diff.new, failOn).length ? ExitCode.findings : ExitCode.ok;
}

async function readReport(path: string): Promise<Report> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new LintelError("LINTEL_E_INPUT_FILE", `cannot read ${path}`, {
      next: `lintel check --format json > ${path}`,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LintelError("LINTEL_E_INPUT_FILE", `${path} is not JSON`, {
      next: `lintel check --format json > ${path}`,
    });
  }
  const parsed = Report.safeParse(json);
  if (!parsed.success) {
    throw new LintelError("LINTEL_E_INPUT_FILE", `${path} is not a lintel.findings/v1 report`, {
      cause: "it was produced by a different tool or an incompatible Lintel version",
      details: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n"),
    });
  }
  return parsed.data;
}
