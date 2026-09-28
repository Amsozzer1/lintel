import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkMigrations } from "../../core/ci.ts";
import { ExitCode } from "../../core/errors.ts";
import { atOrAbove } from "../../core/findings.ts";
import { renderDiffHuman } from "../format/human.ts";
import { decodeState, renderDiffMarkdown } from "../format/markdown.ts";
import { err, out } from "../io.ts";
import { parseFailOn, parseFormat } from "../options.ts";

export interface CiOptions {
  baseRef: string;
  headRef?: string;
  supabaseDir?: string;
  outDir?: string;
  format?: string;
  failOn?: string;
  previousComment?: string;
  pull?: boolean;
}

export async function run(opts: CiOptions): Promise<number> {
  const format = parseFormat(opts.format);
  const failOn = parseFailOn(opts.failOn);
  const result = await checkMigrations({
    repoDir: process.cwd(),
    supabaseDir: opts.supabaseDir ?? "supabase",
    baseRef: opts.baseRef,
    headRef: opts.headRef,
    allowPull: opts.pull !== false,
    onProgress: (m) => err(m),
  });

  if (opts.outDir) {
    await mkdir(opts.outDir, { recursive: true });
    await Promise.all([
      writeFile(join(opts.outDir, "base.json"), JSON.stringify(result.base, null, 2)),
      writeFile(join(opts.outDir, "head.json"), JSON.stringify(result.head, null, 2)),
      writeFile(join(opts.outDir, "diff.json"), JSON.stringify(result.diff, null, 2)),
    ]);
  }

  if (format === "json") out(JSON.stringify(result.diff, null, 2));
  else if (format === "markdown") {
    const previous = opts.previousComment
      ? decodeState(await readFile(opts.previousComment, "utf8"))
      : undefined;
    out(
      renderDiffMarkdown(result.diff, {
        failOn,
        baseLabel: result.base.target.label,
        headLabel: result.head.target.label,
        previous,
      }),
    );
  } else out(renderDiffHuman(result.diff));

  return atOrAbove(result.diff.new, failOn).length ? ExitCode.findings : ExitCode.ok;
}
