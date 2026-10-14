/**
 * Replay each sampled repository's migration history with Lintel's own pipeline, one isolated
 * database per commit.
 *
 *   node study/replay.ts [concurrency]
 *
 * Reads study/private/sample.json. Writes study/private/raw/<owner>__<name>.json, which names the
 * repository and its tables, so it stays private. Prints progress without names.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import { runChecks } from "../src/core/check.ts";
import { withClient } from "../src/core/db.ts";
import { LintelError, toLintelError } from "../src/core/errors.ts";
import { exposedRelations } from "../src/core/probes/exposure.ts";
import { applyFiles } from "../src/core/replay/apply.ts";
import { readAtRef } from "../src/core/replay/git.ts";
import { assertIsolated, NETWORK, startIsolatedDb } from "./isolated-db.ts";

export const MAX_COMMITS = 30;
const PRIVATE = new URL("private/", import.meta.url);
const CLONES = new URL("clones/", PRIVATE);
// --max N changes the cap and --out DIR writes elsewhere (e.g. to measure what the cap misses);
// --only repo-003,repo-009 limits the run.
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MAX = Number(flag("max") ?? MAX_COMMITS);
const RAW = new URL(`${flag("out") ?? "raw"}/`, PRIVATE);
mkdirSync(CLONES, { recursive: true });
mkdirSync(RAW, { recursive: true });

interface Sampled {
  repo: string;
  branch: string;
}

export interface CommitResult {
  sha: string;
  /** Committer date. */
  date: string;
  authorDate?: string;
  index: number;
  migrations: number;
  skipped: number;
  applied: boolean;
  failure?: { code: string; message: string; file?: string; sqlstate?: string };
  findings?: {
    rule: string;
    level: string;
    schema?: string;
    name?: string;
    proven: boolean;
    /** Kept for rls_policy_always_true: it names the roles the policy applies to. */
    message?: string;
  }[];
  /**
   * Study measure, not a Lintel check: permissive policies for anon or public whose USING or
   * WITH CHECK is literally true. Splinter skips SELECT ones on purpose.
   */
  alwaysTrue?: { table: string; policy: string; cmd: string; roles: string[] }[];
  exposed?: {
    schema: string;
    name: string;
    kind: string;
    rls: boolean;
    securityInvoker: boolean;
  }[];
  /** Every table and view in public, to tell a fixed exposure from a dropped relation. */
  relations?: { name: string; kind: string; rls: boolean }[];
  unverified?: { schema: string; name: string; reason: string }[];
  ms: number;
}

/** First, last and evenly spaced in between, as pre-registered. */
export function capCommits<T>(commits: T[], max: number): T[] {
  if (commits.length <= max) return commits;
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) picked.add(Math.round((i * (commits.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => commits[i] as T);
}

async function clone(s: Sampled): Promise<string> {
  const dir = new URL(`${s.repo.replace("/", "__")}/`, CLONES).pathname;
  if (!existsSync(dir)) {
    await execa("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      "--single-branch",
      "--branch",
      s.branch,
      `https://github.com/${s.repo}.git`,
      dir,
    ]);
  }
  return dir;
}

async function replayCommit(
  dir: string,
  sha: string,
  date: string,
  index: number,
): Promise<CommitResult> {
  const started = performance.now();
  // A blob-less clone fetches each file on first read; hundreds of parallel lazy fetches fail
  // now and then. One batched read fetches them all first.
  const blobs = (
    await execa(
      "git",
      ["ls-tree", "-r", "--object-only", sha, "--", "supabase/migrations/", "supabase/seed.sql"],
      { cwd: dir },
    )
  ).stdout;
  if (blobs.trim())
    await execa("git", ["cat-file", "--batch"], { cwd: dir, input: blobs, stdout: "ignore" });
  const files = await readAtRef(dir, sha, "supabase");
  const base = {
    sha,
    date,
    index,
    migrations: files.migrations.length,
    skipped: files.skipped.length,
  };
  const db = await startIsolatedDb();
  try {
    const networks = (
      await execa("docker", [
        "inspect",
        db.container,
        "--format",
        "{{json .NetworkSettings.Networks}}",
      ])
    ).stdout;
    if (Object.keys(JSON.parse(networks)).join() !== NETWORK)
      throw new Error(`replay container is attached to ${networks}`);
    try {
      await applyFiles(db, files, `commit ${index}`);
    } catch (err) {
      const e = toLintelError(err);
      if (e.code !== "LINTEL_E_MIGRATION") throw e;
      return {
        ...base,
        applied: false,
        failure: {
          code: e.code,
          message: e.message,
          ...(e.migration ? { file: e.migration.file, sqlstate: e.migration.postgres.code } : {}),
        },
        ms: Math.round(performance.now() - started),
      };
    }
    const report = await runChecks(db.url, {
      label: `commit ${index}`,
      replay: true,
      probes: true,
    });
    const { exposed, relations, alwaysTrue } = await withClient(db.url, async (c) => ({
      alwaysTrue: (
        await c.query<{ table: string; policy: string; cmd: string; roles: string[] }>(
          `select tablename as table, policyname as policy, cmd, roles::text[] as roles
             from pg_policies
            where schemaname = 'public' and permissive = 'PERMISSIVE'
              and roles && array['anon', 'public']::name[]
              and (lower(regexp_replace(coalesce(qual, ''), '[\\s()]', '', 'g')) = 'true'
                or lower(regexp_replace(coalesce(with_check, ''), '[\\s()]', '', 'g')) = 'true')
            order by 1, 2`,
        )
      ).rows,
      exposed: await exposedRelations(c, ["public"], "anon"),
      relations: (
        await c.query<{ name: string; kind: string; rls: boolean }>(
          `select relname as name, relkind::text as kind, relrowsecurity as rls from pg_class
            where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm')
            order by 1`,
        )
      ).rows,
    }));
    return {
      ...base,
      applied: true,
      findings: report.findings.map((f) => ({
        rule: f.rule,
        level: f.level,
        ...(f.object.schema ? { schema: f.object.schema } : {}),
        ...(f.object.name ? { name: f.object.name } : {}),
        proven: f.probe_state === "proven",
        ...(f.rule === "rls_policy_always_true" ? { message: f.message } : {}),
      })),
      exposed,
      relations,
      alwaysTrue,
      unverified: report.probes.unverified ?? [],
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await db.stop();
  }
}

async function replayRepo(s: Sampled, label: string): Promise<void> {
  const out = new URL(`${s.repo.replace("/", "__")}.json`, RAW);
  if (existsSync(out)) return;
  const started = performance.now();
  const dir = await clone(s);
  const log = (
    await execa(
      "git",
      [
        "log",
        "--reverse",
        "--format=%H %cI %aI",
        s.branch,
        "--",
        "supabase/migrations",
        "supabase/seed.sql",
      ],
      { cwd: dir },
    )
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  const all = log.map((l, i) => ({
    sha: l.split(" ")[0] as string,
    date: l.split(" ")[1] as string,
    authorDate: l.split(" ")[2] as string,
    index: i,
  }));
  const sampled = capCommits(all, MAX);
  const results: CommitResult[] = [];
  for (const c of sampled) {
    try {
      results.push({
        ...(await replayCommit(dir, c.sha, c.date, c.index)),
        authorDate: c.authorDate,
      });
    } catch (err) {
      const e = err instanceof LintelError ? err : toLintelError(err);
      results.push({
        sha: c.sha,
        date: c.date,
        authorDate: c.authorDate,
        index: c.index,
        migrations: 0,
        skipped: 0,
        applied: false,
        failure: { code: e.code, message: e.message },
        ms: 0,
      });
    }
  }
  writeFileSync(
    out,
    JSON.stringify(
      {
        repo: s.repo,
        branch: s.branch,
        commitsTouching: all.length,
        sampled: results.length,
        results,
      },
      null,
      1,
    ),
  );
  // The private disclosure list grows during the run: a HEAD that still exposes a table.
  const head = results.at(-1);
  const headTables = head?.applied
    ? (head.exposed ?? [])
        .filter((e) => (e.kind === "r" || e.kind === "p") && !e.rls)
        .map((e) => e.name)
    : [];
  if (head && headTables.length)
    appendFileSync(
      new URL("disclosure-live.jsonl", PRIVATE),
      `${JSON.stringify({ repo: s.repo, label, sha: head.sha, committed: head.date, tables: headTables })}\n`,
    );
  const applied = results.filter((r) => r.applied).length;
  console.log(
    `${label}: ${all.length} migration commits, ${results.length} sampled, ${applied} applied, ${Math.round((performance.now() - started) / 1000)} s`,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const concurrency = Number(/^\d+$/.test(process.argv[2] ?? "") ? process.argv[2] : 3);
  const sample = JSON.parse(readFileSync(new URL("sample.json", PRIVATE), "utf8")) as Sampled[];
  const only = flag("only")?.split(",");
  const queue = sample
    .map((s, i) => ({ s, label: `repo-${String(i + 1).padStart(3, "0")}` }))
    .filter((q) => !only || only.includes(q.label));
  // A crash can leave study containers behind; they are disposable by construction.
  const leftovers = (await execa("docker", ["ps", "-aq", "--filter", "name=lintel-study-"])).stdout
    .split("\n")
    .filter(Boolean);
  if (leftovers.length) await execa("docker", ["rm", "-f", ...leftovers], { reject: false });
  // Prove isolation once per run, on a real replay container, before any repository is replayed.
  const probe = await startIsolatedDb();
  try {
    console.log(`isolation: ${await assertIsolated(probe.container)}`);
  } finally {
    await probe.stop();
  }
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          await replayRepo(next.s, next.label);
        } catch (err) {
          // One repository failing (deleted, renamed, clone error) must not stop the run.
          const out = new URL(`${next.s.repo.replace("/", "__")}.json`, RAW);
          writeFileSync(
            out,
            JSON.stringify({ repo: next.s.repo, error: String(err).slice(0, 500), results: [] }),
          );
          console.log(`${next.label}: skipped (${String(err).split("\n")[0]?.slice(0, 120)})`);
        }
      }
    }),
  );
}
