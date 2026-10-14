/**
 * Turn the private raw replay results into anonymised, publishable data, and the private
 * disclosure list.
 *
 *   node study/analyze.ts <name> <raw dir> [uncapped dir]     # e.g. n1000 raw-n1000 raw-uncapped
 *
 * Writes study/data/<name>-commits.csv, <name>-exposures.csv, <name>-repo-exposures.csv and
 * <name>-summary.json (no repository, owner or table names, no calendar dates), and
 * study/private/<name>-disclosure.md.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CommitResult } from "./replay.ts";

const [name = "pilot", rawDir = "raw", uncappedDir] = process.argv.slice(2);
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
  commitsTouching?: number;
  sampled?: number;
  error?: string;
  results: CommitResult[];
}
interface Sampled {
  repo: string;
  homepage: string | null;
}

const sample = JSON.parse(readFileSync(new URL("sample.json", PRIVATE), "utf8")) as Sampled[];
const ids = new Map(sample.map((s, i) => [s.repo, `repo-${String(i + 1).padStart(3, "0")}`]));
const readRaw = (dir: string) =>
  existsSync(new URL(`${dir}/`, PRIVATE))
    ? readdirSync(new URL(`${dir}/`, PRIVATE))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(new URL(`${dir}/${f}`, PRIVATE), "utf8")) as Raw)
        .filter((r) => ids.has(r.repo))
        .sort((a, b) => (ids.get(a.repo) ?? "").localeCompare(ids.get(b.repo) ?? ""))
    : [];
const raws = readRaw(rawDir);

const DAY = 86_400_000;
type Kind = "table" | "view" | "materialized view";
const exposure = (e: { kind: string; rls: boolean; securityInvoker: boolean }): Kind | undefined =>
  (e.kind === "r" || e.kind === "p") && !e.rls
    ? "table"
    : e.kind === "v" && !e.securityInvoker
      ? "view"
      : e.kind === "m"
        ? "materialized view"
        : undefined;
const tablesExposed = (r: CommitResult) =>
  (r.exposed ?? []).filter((e) => exposure(e) === "table").map((e) => e.name);
const viewsExposed = (r: CommitResult) =>
  (r.exposed ?? []).filter((e) => exposure(e) === "view" || exposure(e) === "materialized view");
/** Splinter's rls_policy_always_true, where the policy applies to anon (or to public, every role). */
const alwaysTrueLintForAnon = (r: CommitResult) =>
  (r.findings ?? []).filter((f) => {
    if (f.rule !== "rls_policy_always_true") return false;
    const roles = /security for (.+?)\.?$/.exec(f.message ?? "")?.[1]?.split(/,\s*/) ?? [];
    return roles.includes("anon") || roles.includes("public");
  });
/** Study query: an always-true SELECT (or ALL) policy for anon on a table that has RLS on. */
const alwaysTrueSelectForAnon = (r: CommitResult) => {
  const rlsOn = new Set((r.relations ?? []).filter((x) => x.rls).map((x) => x.name));
  return (r.alwaysTrue ?? []).filter(
    (p) => (p.cmd === "SELECT" || p.cmd === "ALL") && rlsOn.has(p.table),
  );
};
const provenReads = (r: CommitResult) =>
  (r.findings ?? []).filter((f) => f.rule === "P001" && f.proven);

const failureClass = (r: CommitResult) => {
  const sqlstate = r.failure?.sqlstate;
  if (!sqlstate) return r.failure?.code === "LINTEL_E_MIGRATION" ? "other" : "replay error";
  if (["42P01", "42883", "42704", "3F000", "42703"].includes(sqlstate))
    return "object created outside migrations";
  if (sqlstate === "0A000") return "extension not in the image";
  if (sqlstate === "P0001") return "raised by the migration itself";
  if (sqlstate === "42501") return "permission";
  if (sqlstate.startsWith("42")) return "other SQL error";
  return "other";
};

interface Interval {
  repo: string;
  relation?: string;
  kind?: Kind;
  startCommit: number;
  startDay: number;
  endCommit: number;
  endDay: number;
  open: boolean;
  outcome: "fixed" | "removed" | "open" | "closed";
  rewritten: boolean;
}

const commitRows = [
  "repo,commit,day,author_day,applied,failure,exposed_tables,exposed_views,always_true_lint_anon,always_true_select_anon,p001_proven,p001_unverified,seconds",
];
const tableIntervals: Interval[] = [];
const repoIntervals: Interval[] = [];
const failures: Record<string, number> = {};
const seconds: number[] = [];
interface RepoRow {
  id: string;
  touching: number;
  sampled: number;
  applied: number;
  headApplied: boolean;
  rewritten: boolean;
  ever: Record<string, boolean>;
  head: Record<string, boolean | null>;
}
const perRepo: RepoRow[] = [];
const MEASURES = ["table", "alwaysTrueLint", "alwaysTrueSelect", "provenRead", "view"] as const;
type Measure = (typeof MEASURES)[number];
const measure: Record<Measure, (r: CommitResult) => boolean> = {
  table: (r) => tablesExposed(r).length > 0,
  alwaysTrueLint: (r) => alwaysTrueLintForAnon(r).length > 0,
  alwaysTrueSelect: (r) => alwaysTrueSelectForAnon(r).length > 0,
  provenRead: (r) => provenReads(r).length > 0,
  view: (r) => viewsExposed(r).length > 0,
};
const headExposed: { raw: Raw; head: CommitResult }[] = [];

for (const raw of raws) {
  const id = ids.get(raw.repo) ?? "repo-???";
  const results = [...raw.results].sort((a, b) => a.index - b.index);
  const t0 = Date.parse(results[0]?.date ?? "");
  const day = (r: CommitResult) => (Date.parse(r.date) - t0) / DAY;
  // Rewritten history: committer dates that go backwards, or a commit committed more than a day
  // after it was authored (a rebase or amend that reset the committer date).
  const rewritten = results.some(
    (r, i) =>
      (i > 0 && Date.parse(r.date) < Date.parse(results[i - 1]?.date ?? "")) ||
      (r.authorDate !== undefined && Date.parse(r.date) - Date.parse(r.authorDate) > DAY),
  );
  const applied = results.filter((r) => r.applied);
  const open = new Map<string, { kind: Kind; start: CommitResult }>();
  let repoOpen: CommitResult | undefined;

  for (const r of results) {
    if (r.ms) seconds.push(r.ms / 1000);
    const exposed = new Map<string, Kind>();
    for (const e of r.exposed ?? []) {
      const kind = exposure(e);
      if (kind) exposed.set(e.name, kind);
    }
    commitRows.push(
      [
        id,
        r.index,
        day(r).toFixed(3),
        r.authorDate ? ((Date.parse(r.authorDate) - t0) / DAY).toFixed(3) : "",
        r.applied,
        r.applied ? "" : failureClass(r),
        tablesExposed(r).length,
        viewsExposed(r).length,
        alwaysTrueLintForAnon(r).length,
        alwaysTrueSelectForAnon(r).length,
        provenReads(r).length,
        (r.unverified ?? []).length,
        (r.ms / 1000).toFixed(1),
      ].join(","),
    );
    if (!r.applied) {
      const c = failureClass(r);
      failures[c] = (failures[c] ?? 0) + 1;
      continue;
    }
    const present = new Set((r.relations ?? []).map((x) => x.name));
    for (const [relation, kind] of exposed)
      if (!open.has(relation)) open.set(relation, { kind, start: r });
    for (const [relation, o] of open) {
      if (exposed.has(relation)) continue;
      tableIntervals.push({
        repo: id,
        relation: pseudonym(raw.repo, relation),
        kind: o.kind,
        startCommit: o.start.index,
        startDay: day(o.start),
        endCommit: r.index,
        endDay: day(r),
        open: false,
        outcome: present.has(relation) ? "fixed" : "removed",
        rewritten,
      });
      open.delete(relation);
    }
    const tablesNow = tablesExposed(r).length > 0;
    if (tablesNow && !repoOpen) repoOpen = r;
    if (!tablesNow && repoOpen) {
      repoIntervals.push({
        repo: id,
        startCommit: repoOpen.index,
        startDay: day(repoOpen),
        endCommit: r.index,
        endDay: day(r),
        open: false,
        outcome: "closed",
        rewritten,
      });
      repoOpen = undefined;
    }
  }
  const last = applied.at(-1);
  for (const [relation, o] of open)
    tableIntervals.push({
      repo: id,
      relation: pseudonym(raw.repo, relation),
      kind: o.kind,
      startCommit: o.start.index,
      startDay: day(o.start),
      endCommit: last?.index ?? o.start.index,
      endDay: last ? day(last) : day(o.start),
      open: true,
      outcome: "open",
      rewritten,
    });
  if (repoOpen && last)
    repoIntervals.push({
      repo: id,
      startCommit: repoOpen.index,
      startDay: day(repoOpen),
      endCommit: last.index,
      endDay: day(last),
      open: true,
      outcome: "open",
      rewritten,
    });

  const head = results.at(-1);
  const headApplied = Boolean(head?.applied);
  const ever = Object.fromEntries(MEASURES.map((m) => [m, applied.some(measure[m])]));
  const headRow = Object.fromEntries(
    MEASURES.map((m) => [m, headApplied && head ? measure[m](head) : null]),
  );
  if (headApplied && head && measure.table(head)) headExposed.push({ raw, head });
  perRepo.push({
    id,
    touching: raw.commitsTouching ?? 0,
    sampled: raw.sampled ?? 0,
    applied: applied.length,
    headApplied,
    rewritten,
    ever,
    head: headRow,
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
    if (survival <= 0.5) return Math.round(t * 100) / 100;
    atRisk -= leaving;
  }
  return null;
}

const BUCKETS: [string, number][] = [
  ["under 1 hour", 1 / 24],
  ["1 hour to 1 day", 1],
  ["1 to 7 days", 7],
  ["7 to 30 days", 30],
  ["30 to 90 days", 90],
  ["90 to 365 days", 365],
  ["over 1 year", Number.POSITIVE_INFINITY],
];
const share = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
function durations(intervals: Interval[]) {
  const closed = intervals.filter((i) => !i.open);
  const open = intervals.filter((i) => i.open);
  const days = (i: Interval) => i.endDay - i.startDay;
  const bucket = (xs: Interval[]) =>
    Object.fromEntries(
      BUCKETS.map(([label, max], k) => [
        label,
        xs.filter((i) => days(i) < max && days(i) >= (k ? (BUCKETS[k - 1]?.[1] ?? 0) : 0)).length,
      ]),
    );
  const longer = (xs: Interval[], d: number) => xs.filter((i) => days(i) > d).length;
  return {
    total: intervals.length,
    closed: closed.length,
    openAtLastReplay: open.length,
    closedLongerThan1Day: {
      n: longer(closed, 1),
      pctOfClosed: share(longer(closed, 1), closed.length),
    },
    closedLongerThan7Days: {
      n: longer(closed, 7),
      pctOfClosed: share(longer(closed, 7), closed.length),
    },
    // An open exposure already longer than the threshold is known to exceed it; shorter ones aren't known.
    knownLongerThan1Day: {
      n: longer(intervals, 1),
      pctOfAll: share(longer(intervals, 1), intervals.length),
    },
    knownLongerThan7Days: {
      n: longer(intervals, 7),
      pctOfAll: share(longer(intervals, 7), intervals.length),
    },
    closedWithinOneMigrationCommit: closed.filter((i) => i.endCommit - i.startCommit === 1).length,
    distributionClosed: bucket(closed),
    distributionOpenSoFar: bucket(open),
    kaplanMeierMedianDays: kmMedian(intervals.map((i) => ({ t: days(i), event: !i.open }))),
    kaplanMeierMedianCommits: kmMedian(
      intervals.map((i) => ({ t: i.endCommit - i.startCommit, event: !i.open })),
    ),
    inRepositoriesWithRewrittenHistory: intervals.filter((i) => i.rewritten).length,
  };
}

// Cap recheck: compare uncapped replays with the capped ones for the same repositories.
const capRecheck = (() => {
  if (!uncappedDir) return undefined;
  const uncapped = readRaw(uncappedDir);
  const starts = (raw: Raw) => {
    const m = new Map<string, number>();
    for (const r of raw.results.filter((x) => x.applied).sort((a, b) => a.index - b.index))
      for (const t of tablesExposed(r)) if (!m.has(t)) m.set(t, r.index);
    return m;
  };
  let missed = 0;
  let moved = 0;
  let exposures = 0;
  const repos = uncapped.map((u) => {
    const capped = raws.find((r) => r.repo === u.repo);
    const a = capped ? starts(capped) : new Map<string, number>();
    const b = starts(u);
    exposures += b.size;
    const m = [...b.keys()].filter((k) => !a.has(k)).length;
    const s = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).length;
    missed += m;
    moved += s;
    return {
      repo: ids.get(u.repo),
      commits: u.results.length,
      exposuresUncapped: b.size,
      missedByCap: m,
      startMoved: s,
    };
  });
  return {
    repositories: uncapped.length,
    tableExposures: exposures,
    missedByCap: missed,
    startMoved: moved,
    perRepository: repos,
  };
})();

const denominator = {
  sampled: perRepo.length,
  notReplayable: raws.filter((r) => r.error).length,
  withAnAppliedCommit: perRepo.filter((r) => r.applied > 0).length,
  headReplays: perRepo.filter((r) => r.headApplied).length,
};
const headline = Object.fromEntries(
  MEASURES.map((m) => {
    const ever = perRepo.filter((r) => r.ever[m]).length;
    const head = perRepo.filter((r) => r.head[m] === true).length;
    return [
      m,
      {
        ever: {
          n: ever,
          of: denominator.withAnAppliedCommit,
          pct: share(ever, denominator.withAnAppliedCommit),
        },
        atHead: { n: head, of: denominator.headReplays, pct: share(head, denominator.headReplays) },
      },
    ];
  }),
);

writeFileSync(new URL(`${name}-commits.csv`, DATA), `${commitRows.join("\n")}\n`);
const intervalCsv = (xs: Interval[], withRelation: boolean) =>
  [
    `repo,${withRelation ? "relation,kind," : ""}start_commit,start_day,end_commit,end_day,outcome,commits,days,history_rewritten`,
    ...xs.map((i) =>
      [
        i.repo,
        ...(withRelation ? [i.relation, i.kind] : []),
        i.startCommit,
        i.startDay.toFixed(3),
        i.endCommit,
        i.endDay.toFixed(3),
        i.outcome,
        i.endCommit - i.startCommit,
        (i.endDay - i.startDay).toFixed(3),
        i.rewritten,
      ].join(","),
    ),
  ].join("\n");
writeFileSync(new URL(`${name}-exposures.csv`, DATA), `${intervalCsv(tableIntervals, true)}\n`);
writeFileSync(
  new URL(`${name}-repo-exposures.csv`, DATA),
  `${intervalCsv(repoIntervals, false)}\n`,
);

const summary = {
  denominators: denominator,
  measures: {
    note: "ever: over repositories with at least one applied commit; atHead: over repositories whose HEAD replays",
    ...headline,
  },
  durations: {
    note: "committer dates; per repository = first commit with any anon-readable table without RLS to the first later commit with none",
    perRepository: durations(repoIntervals),
    perTable: durations(tableIntervals.filter((i) => i.kind === "table")),
    tableOutcomes: {
      fixed: tableIntervals.filter((i) => i.kind === "table" && i.outcome === "fixed").length,
      removed: tableIntervals.filter((i) => i.kind === "table" && i.outcome === "removed").length,
      open: tableIntervals.filter((i) => i.kind === "table" && i.open).length,
    },
  },
  history: { repositoriesWithRewrittenHistory: perRepo.filter((r) => r.rewritten).length },
  replay: {
    commitsTouchingMigrations: perRepo.map((r) => r.touching),
    commitsSampled: perRepo.reduce((n, r) => n + r.sampled, 0),
    commitsApplied: perRepo.reduce((n, r) => n + r.applied, 0),
    failures,
    secondsPerCommit: {
      mean: seconds.length
        ? Math.round((100 * seconds.reduce((a, b) => a + b, 0)) / seconds.length) / 100
        : null,
      max: seconds.length ? Math.max(...seconds) : null,
    },
  },
  capRecheck,
};
writeFileSync(new URL(`${name}-summary.json`, DATA), `${JSON.stringify(summary, null, 2)}\n`);

// Private: repositories still exposing a table at HEAD, with what creates each table and whether
// the project looks deployed. The README is read for URLs; nothing is visited.
const PLACEHOLDER =
  /your-|example\.|localhost|127\.0\.0\.1|<|\{|github\.com|githubusercontent|shields\.io|supabase\.(com|co)\/(docs|dashboard)|npmjs|vercel\.com\/(new|button)|deno\.land|img\.|badge/i;
const lines = [`# ${name}: private disclosure list (never publish)`, ""];
for (const { raw, head } of headExposed) {
  const dir = new URL(`clones/${raw.repo.replace("/", "__")}/`, PRIVATE).pathname;
  const git = (...a: string[]) => {
    try {
      return execFileSync("git", a, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };
  let readme = "";
  try {
    readme = execFileSync(
      "gh",
      ["api", `repos/${raw.repo}/readme`, "-H", "Accept: application/vnd.github.raw"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {}
  const homepage = sample.find((s) => s.repo === raw.repo)?.homepage;
  const urls = [
    ...new Set([
      ...(homepage ? [homepage] : []),
      ...[...readme.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, "")),
    ]),
  ].filter((u) => !PLACEHOLDER.test(u));
  const files = git("ls-tree", "--name-only", head.sha, "supabase/migrations/")
    .trim()
    .split("\n")
    .filter(Boolean);
  const sources = new Map(files.map((p) => [p, git("show", `${head.sha}:${p}`)]));
  lines.push(
    `## ${raw.repo} (${ids.get(raw.repo)})`,
    "",
    `- Looks deployed: ${urls.length ? `yes: ${urls.slice(0, 4).join(", ")}${homepage && urls.includes(homepage) ? " (first is the repository's homepage field)" : ""}` : "no live URL found in the homepage field or README"}`,
    `- HEAD ${head.sha} (committed ${head.date})`,
  );
  for (const t of tablesExposed(head)) {
    const re = new RegExp(
      `create\\s+table\\s+(if\\s+not\\s+exists\\s+)?("?public"?\\.)?"?${t}"?(\\s|\\()`,
      "i",
    );
    const creator = [...sources].find(([, sql]) => re.test(sql))?.[0];
    const added = creator
      ? git("log", "--diff-filter=A", "--format=%H %cI", head.sha, "--", creator)
          .trim()
          .split("\n")
          .at(-1)
      : "";
    lines.push(
      `- \`public.${t}\`: RLS off, anon can select. Created in \`${creator ?? "(no create table found)"}\`${added ? `, added in ${added.split(" ")[0]} (${added.split(" ")[1]})` : ""}`,
    );
  }
  lines.push("");
}
writeFileSync(new URL(`${name}-disclosure.md`, PRIVATE), `${lines.join("\n")}\n`);
console.log(
  JSON.stringify(
    { denominators: denominator, measures: headline, privateDisclosureEntries: headExposed.length },
    null,
    1,
  ),
);
