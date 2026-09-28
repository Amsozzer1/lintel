/**
 * checkMigrations: replay base and head migrations into two throwaway databases,
 * check both, and diff. The GitHub Action, `lintel migrations check` and the MCP tool
 * all run this one function.
 */
import { runChecks } from "./check.ts";
import { diffReports } from "./diff.ts";
import type { Diff, Report } from "./findings.ts";
import { applyFiles } from "./replay/apply.ts";
import { type ManagedDb, startDb } from "./replay/docker.ts";
import { readAtRef, readWorktree, type SupabaseFiles, shortSha } from "./replay/git.ts";

export interface CheckMigrationsInput {
  repoDir: string;
  /** Path of the Supabase directory relative to the repo root (default `supabase`). */
  supabaseDir?: string;
  baseRef: string;
  /** A git ref, or undefined for the working tree. */
  headRef?: string | undefined;
  image?: string;
  allowPull?: boolean;
  onProgress?: (message: string) => void;
}

export interface CheckMigrationsResult {
  base: Report;
  head: Report;
  diff: Diff;
}

export async function checkMigrations(input: CheckMigrationsInput): Promise<CheckMigrationsResult> {
  const supabaseDir = input.supabaseDir ?? "supabase";
  const progress = input.onProgress ?? (() => {});
  const [baseFiles, headFiles, baseLabel, headLabel] = await Promise.all([
    readAtRef(input.repoDir, input.baseRef, supabaseDir),
    input.headRef
      ? readAtRef(input.repoDir, input.headRef, supabaseDir)
      : readWorktree(input.repoDir, supabaseDir),
    shortSha(input.repoDir, input.baseRef).then((s) => `base@${s}`),
    input.headRef
      ? shortSha(input.repoDir, input.headRef).then((s) => `head@${s}`)
      : Promise.resolve("head@worktree"),
  ]);

  progress("starting two throwaway databases…");
  const started = await Promise.allSettled([startDb(dbOpts(input)), startDb(dbOpts(input))]);
  const dbs = started.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  try {
    const failed = started.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
    const [baseDb, headDb] = dbs as [ManagedDb, ManagedDb];
    progress(
      `applying ${baseFiles.migrations.length} base and ${headFiles.migrations.length} head migrations…`,
    );
    const [base, head] = await Promise.all([
      replayAndCheck(baseDb, baseFiles, baseLabel),
      replayAndCheck(headDb, headFiles, headLabel),
    ]);
    progress("diffing…");
    return { base, head, diff: diffReports(base, head) };
  } finally {
    await Promise.all(dbs.map((db) => db.stop()));
  }
}

async function replayAndCheck(db: ManagedDb, files: SupabaseFiles, label: string): Promise<Report> {
  await applyFiles(db, files, label);
  return runChecks(db.url, { label, replay: true });
}

function dbOpts(input: CheckMigrationsInput) {
  return {
    ...(input.image ? { image: input.image } : {}),
    ...(input.allowPull !== undefined ? { allowPull: input.allowPull } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  };
}
