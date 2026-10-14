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
import { readFileSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import { MIGRATION_FILE } from "../src/core/supabase/files.ts";

export const SEED = 20261013;
const N = Number(process.argv[2] ?? 10);
const PRIVATE = new URL("private/", import.meta.url);
const EXCLUDED_OWNERS = new Set(["supabase", "supabase-community"]);
const KEYWORDS =
  /\b(template|starter|boilerplate|example|tutorial|course|workshop|sample|scaffold)s?\b/i;

/** mulberry32: a small seeded PRNG, so the draw can be repeated exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gh = async (path: string) => {
  const r = await execa("gh", ["api", path], { reject: false });
  return r.exitCode === 0 ? JSON.parse(r.stdout) : undefined;
};

const candidates = Object.keys(
  JSON.parse(readFileSync(new URL("candidates.json", PRIVATE), "utf8")),
).sort();
const random = rng(SEED);
const order = candidates
  .map((repo) => ({ repo, key: random() }))
  .sort((a, b) => a.key - b.key)
  .map((x) => x.repo);

const screening: { repo: string; eligible: boolean; reason?: string }[] = [];
const sample: Record<string, unknown>[] = [];
for (const repo of order) {
  if (sample.length >= N) break;
  const reject = (reason: string) => screening.push({ repo, eligible: false, reason });
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
        screening.push({ repo, eligible: true });
        sample.push({
          repo,
          branch,
          files,
          stars: meta.stargazers_count,
          created: meta.created_at,
          pushed: meta.pushed_at,
          homepage: meta.homepage ?? null,
          description: meta.description ?? null,
        });
      }
    }
  }
}

writeFileSync(
  new URL("screening.jsonl", PRIVATE),
  `${screening.map((s) => JSON.stringify(s)).join("\n")}\n`,
);
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
