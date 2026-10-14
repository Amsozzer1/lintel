/**
 * Turn the private raw replay results into anonymised, publishable data, and the private
 * disclosure list.
 *
 *   node study/analyze.ts <name>       # e.g. pilot
 *
 * Writes study/data/<name>-commits.csv, <name>-exposures.csv and <name>-summary.json (no
 * repository, owner or table names, no calendar dates), and study/private/<name>-disclosure.md.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import type { CommitResult } from "./replay.ts";

const name = process.argv[2] ?? "pilot";
const PRIVATE = new URL("private/", import.meta.url);
const DATA = new URL("data/", import.meta.url);
mkdirSync(DATA, { recursive: true });

const saltFile = new URL("salt.txt", PRIVATE);
if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(32).toString("hex"));
const salt = readFileSync(saltFile, "utf8").trim();
const pseudonym = (repo: string, relation: string) =>
  createHmac("sha256", salt).update(`${repo}\0${relation}`).digest("hex").slice(0, 10);

interface Raw {
  repo: string;
  commitsTouching: number;
  sampled: number;
  results: CommitResult[];
}
interface Sampled {
  repo: string;
  homepage: string | null;
  stars: number;
}

const sample = JSON.parse(readFileSync(new URL("sample.json", PRIVATE), "utf8")) as Sampled[];
const ids = new Map(sample.map((s, i) => [s.repo, `repo-${String(i + 1).padStart(3, "0")}`]));
const raws = readdirSync(new URL("raw/", PRIVATE))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(new URL(`raw/${f}`, PRIVATE), "utf8")) as Raw)
  .sort((a, b) => (ids.get(a.repo) ?? "").localeCompare(ids.get(b.repo) ?? ""));

const DAY = 86_400_000;
type Kind = "table" | "view" | "materialized view";
/** What makes a relation readable by anon despite (or without) RLS. */
const exposure = (e: { kind: string; rls: boolean; securityInvoker: boolean }): Kind | undefined =>
  (e.kind === "r" || e.kind === "p") && !e.rls
    ? "table"
    : e.kind === "v" && !e.securityInvoker
      ? "view"
      : e.kind === "m"
        ? "materialized view"
        : undefined;

const failureClass = (sqlstate?: string) =>
  !sqlstate
    ? "not a migration error"
    : ["42P01", "42883", "42704", "3F000", "42703"].includes(sqlstate)
      ? "object created outside migrations"
      : sqlstate === "0A000"
        ? "extension not in the image"
        : sqlstate === "P0001"
          ? "raised by the migration itself"
          : sqlstate === "42501"
            ? "permission"
            : sqlstate.startsWith("42")
              ? "other SQL error"
              : "other";

interface Interval {
  repo: string;
  relation: string;
  kind: Kind;
  startCommit: number;
  startDay: number;
  endCommit: number;
  endDay: number;
  outcome: "fixed" | "removed" | "open";
}

const commitRows: string[] = [
  "repo,commit,day,applied,failure,exposed_tables,exposed_views,exposed_matviews,lint_errors,lint_warns,p001_proven,seconds",
];
const intervals: Interval[] = [];
const perRepo: {
  id: string;
  touching: number;
  sampled: number;
  applied: number;
  everExposed: boolean;
  exposedAtHead: boolean | null;
  headApplied: boolean;
}[] = [];
const headExposures: { repo: Raw; relations: string[]; homepage: string | null }[] = [];
const failures: Record<string, number> = {};
const repoIntervals: { commits: number; days: number; open: boolean }[] = [];
const seconds: number[] = [];

for (const raw of raws) {
  const id = ids.get(raw.repo) ?? "repo-???";
  const results = [...raw.results].sort((a, b) => a.index - b.index);
  const t0 = Date.parse(results[0]?.date ?? "");
  const day = (r: CommitResult) => Math.round((Date.parse(r.date) - t0) / DAY);
  const open = new Map<string, { kind: Kind; start: CommitResult }>();
  let everExposed = false;
  let lastApplied: CommitResult | undefined;
  let repoOpen: CommitResult | undefined;

  for (const r of results) {
    if (r.ms) seconds.push(r.ms / 1000);
    const exposed = new Map<string, Kind>();
    for (const e of r.exposed ?? []) {
      const kind = exposure(e);
      if (kind) exposed.set(e.name, kind);
    }
    const lints = r.findings ?? [];
    commitRows.push(
      [
        id,
        r.index,
        day(r),
        r.applied,
        r.applied ? "" : failureClass(r.failure?.sqlstate),
        [...exposed.values()].filter((k) => k === "table").length,
        [...exposed.values()].filter((k) => k === "view").length,
        [...exposed.values()].filter((k) => k === "materialized view").length,
        lints.filter((f) => f.level === "error" && f.rule !== "P001").length,
        lints.filter((f) => f.level === "warn" && f.rule !== "P001").length,
        lints.filter((f) => f.rule === "P001" && f.proven).length,
        (r.ms / 1000).toFixed(1),
      ].join(","),
    );
    if (!r.applied) {
      const c = failureClass(r.failure?.sqlstate);
      failures[c] = (failures[c] ?? 0) + 1;
      continue;
    }
    lastApplied = r;
    const tablesNow = [...exposed.values()].includes("table");
    if (tablesNow) everExposed = true;
    // Per repository: from the first commit with any exposed table to the first without one.
    if (tablesNow && !repoOpen) repoOpen = r;
    if (!tablesNow && repoOpen) {
      repoIntervals.push({
        commits: r.index - repoOpen.index,
        days: day(r) - day(repoOpen),
        open: false,
      });
      repoOpen = undefined;
    }
    const present = new Set((r.relations ?? []).map((x) => x.name));
    for (const [relation, kind] of exposed)
      if (!open.has(relation)) open.set(relation, { kind, start: r });
    for (const [relation, o] of open) {
      if (exposed.has(relation)) continue;
      intervals.push({
        repo: id,
        relation: pseudonym(raw.repo, relation),
        kind: o.kind,
        startCommit: o.start.index,
        startDay: day(o.start),
        endCommit: r.index,
        endDay: day(r),
        outcome: present.has(relation) ? "fixed" : "removed",
      });
      open.delete(relation);
    }
  }
  if (repoOpen && lastApplied)
    repoIntervals.push({
      commits: lastApplied.index - repoOpen.index,
      days: day(lastApplied) - day(repoOpen),
      open: true,
    });
  const head = results.at(-1);
  for (const [relation, o] of open) {
    intervals.push({
      repo: id,
      relation: pseudonym(raw.repo, relation),
      kind: o.kind,
      startCommit: o.start.index,
      startDay: day(o.start),
      endCommit: lastApplied?.index ?? o.start.index,
      endDay: lastApplied ? day(lastApplied) : day(o.start),
      outcome: "open",
    });
  }
  const headApplied = Boolean(head?.applied);
  const headTables = headApplied
    ? (head?.exposed ?? []).filter((e) => exposure(e) === "table").map((e) => e.name)
    : [];
  if (headTables.length) {
    headExposures.push({
      repo: raw,
      relations: headTables,
      homepage: sample.find((s) => s.repo === raw.repo)?.homepage ?? null,
    });
  }
  perRepo.push({
    id,
    touching: raw.commitsTouching,
    sampled: raw.sampled,
    applied: results.filter((r) => r.applied).length,
    everExposed,
    exposedAtHead: headApplied ? headTables.length > 0 : null,
    headApplied,
  });
}

/** Kaplan–Meier median: the first time survival drops to 0.5 or below; open intervals are censored. */
function kmMedian(times: { t: number; event: boolean }[]): number | null {
  const sorted = [...times].sort((a, b) => a.t - b.t);
  let atRisk = sorted.length;
  let survival = 1;
  for (let i = 0; i < sorted.length; ) {
    const t = sorted[i]?.t ?? 0;
    let events = 0;
    let leaving = 0;
    while (i < sorted.length && sorted[i]?.t === t) {
      if (sorted[i]?.event) events++;
      leaving++;
      i++;
    }
    if (events) survival *= 1 - events / atRisk;
    if (survival <= 0.5) return t;
    atRisk -= leaving;
  }
  return null;
}

const tables = intervals.filter((i) => i.kind === "table");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] ?? 0) : null;
};

writeFileSync(new URL(`${name}-commits.csv`, DATA), `${commitRows.join("\n")}\n`);
writeFileSync(
  new URL(`${name}-exposures.csv`, DATA),
  `${[
    "repo,relation,kind,start_commit,start_day,end_commit,end_day,outcome,commits,days",
    ...intervals.map((i) =>
      [
        i.repo,
        i.relation,
        i.kind,
        i.startCommit,
        i.startDay,
        i.endCommit,
        i.endDay,
        i.outcome,
        i.endCommit - i.startCommit,
        i.endDay - i.startDay,
      ].join(","),
    ),
  ].join("\n")}\n`,
);

const summary = {
  repositories: raws.length,
  repositoriesEverExposingATable: perRepo.filter((r) => r.everExposed).length,
  repositoriesExposingATableAtHead: perRepo.filter((r) => r.exposedAtHead === true).length,
  repositoriesWhoseHeadDidNotReplay: perRepo.filter((r) => !r.headApplied).length,
  commitsTouchingMigrations: perRepo.map((r) => r.touching),
  commitsSampled: perRepo.reduce((n, r) => n + r.sampled, 0),
  commitsApplied: perRepo.reduce((n, r) => n + r.applied, 0),
  replayFailures: failures,
  repositoriesWithAnAppliedCommit: perRepo.filter((r) => r.applied > 0).length,
  repositoryExposures: {
    note: "per repository: first commit with any anon-readable table without RLS, to the first later commit with none",
    total: repoIntervals.length,
    closed: repoIntervals.filter((i) => !i.open).length,
    openAtLastReplay: repoIntervals.filter((i) => i.open).length,
    kaplanMeierMedianDays: kmMedian(repoIntervals.map((i) => ({ t: i.days, event: !i.open }))),
    kaplanMeierMedianCommits: kmMedian(
      repoIntervals.map((i) => ({ t: i.commits, event: !i.open })),
    ),
  },
  tableExposures: {
    total: tables.length,
    fixed: tables.filter((i) => i.outcome === "fixed").length,
    removed: tables.filter((i) => i.outcome === "removed").length,
    openAtLastReplay: tables.filter((i) => i.outcome === "open").length,
    kaplanMeierMedianDays: kmMedian(
      tables.map((i) => ({ t: i.endDay - i.startDay, event: i.outcome !== "open" })),
    ),
    kaplanMeierMedianCommits: kmMedian(
      tables.map((i) => ({ t: i.endCommit - i.startCommit, event: i.outcome !== "open" })),
    ),
  },
  otherExposures: {
    views: intervals.filter((i) => i.kind === "view").length,
    materializedViews: intervals.filter((i) => i.kind === "materialized view").length,
  },
  secondsPerCommit: { median: median(seconds), max: Math.max(...seconds) },
  perRepository: perRepo,
};
writeFileSync(new URL(`${name}-summary.json`, DATA), `${JSON.stringify(summary, null, 2)}\n`);

// Private: repositories still exposing a table at HEAD that look deployed. The README is read for
// URLs; nothing is visited.
const lines = [`# ${name}: private disclosure list (never publish)`, ""];
for (const h of headExposures) {
  const readme = await execa(
    "gh",
    ["api", `repos/${h.repo.repo}/readme`, "-H", "Accept: application/vnd.github.raw"],
    { reject: false },
  );
  const urls = [
    ...(h.homepage ? [h.homepage] : []),
    ...String(readme.stdout).matchAll(/https?:\/\/[^\s)"'<>\]]+/g),
  ]
    .map((u) => String(u).replace(/[.,;:]+$/, ""))
    .filter(
      (u) =>
        !/github\.com|githubusercontent|shields\.io|supabase\.com\/docs|npmjs|vercel\.com\/(new|button)|localhost|127\.0\.0\.1|example\.com/i.test(
          u,
        ),
    );
  const head = h.repo.results.at(-1);
  lines.push(
    `## ${h.repo.repo} (${ids.get(h.repo.repo)})`,
    "",
    `- Looks deployed: ${urls.length ? "yes" : "no live URL found"}${urls.length ? `: ${[...new Set(urls)].slice(0, 5).join(", ")}` : ""}`,
    `- HEAD ${head?.sha.slice(0, 7)} (${head?.date.slice(0, 10)}): tables readable by anon with RLS off: ${h.relations.map((r) => `\`public.${r}\``).join(", ")}`,
    `- Lintel findings at HEAD: ${
      (head?.findings ?? [])
        .filter((f) => f.level === "error")
        .map((f) => `${f.rule} on ${f.schema}.${f.name}${f.proven ? " (proven)" : ""}`)
        .join("; ") || "none"
    }`,
    "",
  );
}
writeFileSync(new URL(`${name}-disclosure.md`, PRIVATE), `${lines.join("\n")}\n`);
console.log(JSON.stringify({ ...summary, perRepository: undefined }, null, 1));
