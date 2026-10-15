/**
 * Screen candidates against the selection criteria (study/README.md) in a seeded random order
 * until N are eligible. Screening in random order and stopping at N is a uniform draw from the
 * eligible repositories.
 *
 *   node study/sample.ts 10
 *
 * Writes study/private/screening.jsonl (every repository screened, with the reason) and
 * study/private/sample.json (the eligible ones). Prints counts only.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import { MIGRATION_FILE } from "../src/core/supabase/files.ts";
import { rng, SEED } from "./random.ts";

const N = Number(process.argv[2] ?? 10);
const PRIVATE = new URL("private/", import.meta.url);
const EXCLUDED_OWNERS = new Set(["supabase", "supabase-community"]);
const KEYWORDS =
  /\b(template|starter|boilerplate|example|tutorial|course|workshop|sample|scaffold)s?\b/i;

/** A GitHub API GET. Undefined only for a real 404; rate limits and server errors are waited out. */
const gh = async (path: string) => {
  for (let attempt = 0; ; attempt++) {
    const r = await execa("gh", ["api", path], { reject: false });
    if (r.exitCode === 0) return JSON.parse(r.stdout);
    const err = `${r.stderr}`;
    if (/HTTP 404|Not Found/i.test(err)) return undefined;
    if (/rate limit|HTTP 403|HTTP 429/i.test(err)) {
      const reset = Number(
        (
          await execa("gh", ["api", "rate_limit", "--jq", ".resources.core.reset"], {
            reject: false,
          })
        ).stdout,
      );
      const wait = Math.max(60_000, reset * 1000 - Date.now() + 5_000);
      console.log(`rate limited; waiting ${Math.round(wait / 60_000)} min`);
      await sleep(wait);
      continue;
    }
    if (attempt >= 4) throw new Error(`gh api ${path}: ${err.slice(0, 200)}`);
    await sleep(5_000 * (attempt + 1));
  }
};

const candidates = Object.keys(
  JSON.parse(readFileSync(new URL("candidates.json", PRIVATE), "utf8")),
).sort();
const random = rng(SEED);
const order = candidates
  .map((repo) => ({ repo, key: random() }))
  .sort((a, b) => a.key - b.key)
  .map((x) => x.repo);

// Resumable: every screened repository is appended as soon as it is decided.
const SCREENING = new URL("screening.jsonl", PRIVATE);
const ELIGIBLE = new URL("eligible.jsonl", PRIVATE);
const read = (file: URL) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
// The pilot wrote sample.json only; carry its eligible entries over once.
if (!existsSync(ELIGIBLE) && existsSync(new URL("sample.json", PRIVATE)))
  for (const e of JSON.parse(readFileSync(new URL("sample.json", PRIVATE), "utf8")))
    appendFileSync(ELIGIBLE, `${JSON.stringify(e)}\n`);
const screening: { repo: string; eligible: boolean; reason?: string }[] = read(SCREENING);
const sample: Record<string, unknown>[] = read(ELIGIBLE);
const done = new Set(screening.map((x) => x.repo));
const decide = (entry: { repo: string; eligible: boolean; reason?: string }) => {
  screening.push(entry);
  appendFileSync(SCREENING, `${JSON.stringify(entry)}\n`);
};
for (const repo of order) {
  if (sample.length >= N) break;
  if (done.has(repo)) continue;
  const reject = (reason: string) => decide({ repo, eligible: false, reason });
  const [owner = "", name = ""] = repo.split("/");
  if (EXCLUDED_OWNERS.has(owner.toLowerCase())) {
    reject("supabase-owned");
    continue;
  }
  const meta = await gh(`repos/${repo}`);
  if (!meta) {
    reject("not accessible");
    continue;
  }
  if (meta.fork) reject("fork");
  else if (meta.archived) reject("archived");
  else if (meta.is_template) reject("template repository");
  else if (KEYWORDS.test(name.replace(/[-_]/g, " ")) || KEYWORDS.test(meta.description ?? ""))
    reject("template/tutorial keyword");
  else {
    const branch = meta.default_branch as string;
    const listing = await gh(`repos/${repo}/contents/supabase/migrations?ref=${branch}`);
    const files = Array.isArray(listing)
      ? listing.filter((f: { name: string }) => MIGRATION_FILE.test(f.name)).length
      : 0;
    if (!Array.isArray(listing)) reject("no root supabase/migrations");
    else if (files < 3) reject("fewer than 3 migration files");
    else {
      const commits = await gh(
        `repos/${repo}/commits?sha=${branch}&path=supabase/migrations&per_page=2`,
      );
      if (!Array.isArray(commits) || commits.length < 2) reject("fewer than 2 migration commits");
      else {
        const entry = {
          repo,
          branch,
          files,
          stars: meta.stargazers_count,
          created: meta.created_at,
          pushed: meta.pushed_at,
          homepage: meta.homepage ?? null,
          description: meta.description ?? null,
        };
        sample.push(entry);
        appendFileSync(ELIGIBLE, `${JSON.stringify(entry)}\n`);
        decide({ repo, eligible: true });
      }
    }
  }
}

writeFileSync(new URL("sample.json", PRIVATE), JSON.stringify(sample, null, 1));
const reasons: Record<string, number> = {};
for (const s of screening)
  if (!s.eligible) reasons[s.reason ?? ""] = (reasons[s.reason ?? ""] ?? 0) + 1;
console.log(
  JSON.stringify(
    {
      candidates: candidates.length,
      screened: screening.length,
      eligible: sample.length,
      rejected: reasons,
    },
    null,
    1,
  ),
);
