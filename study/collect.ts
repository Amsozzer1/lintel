/**
 * Collect candidate repositories: GitHub code search for SQL files under supabase/migrations,
 * sliced by file size because one query returns at most 1000 results.
 *
 *   node study/collect.ts 200..260 900..1000 ...
 *
 * Writes study/private/candidates-raw.jsonl (every hit) and study/private/candidates.json
 * (one entry per repository). Both name repositories, so both stay private.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";

const PRIVATE = new URL("private/", import.meta.url);
mkdirSync(PRIVATE, { recursive: true });
const RAW = new URL("candidates-raw.jsonl", PRIVATE);
const OUT = new URL("candidates.json", PRIVATE);
// Code search allows 10 requests a minute.
const PACE_MS = 6500;

interface Hit {
  repo: string;
  path: string;
  fork: boolean;
  slice: string;
}

const slices = process.argv.slice(2);
if (!slices.length) throw new Error("usage: node study/collect.ts <size range>...");

const repos: Record<string, { fork: boolean; slices: string[]; paths: number }> = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, "utf8"))
  : {};

for (const slice of slices) {
  let total = 0;
  let hits = 0;
  for (let page = 1; page <= 10; page++) {
    const { stdout } = await execa("gh", [
      "api",
      "-X",
      "GET",
      "search/code",
      "-f",
      `q=path:supabase/migrations extension:sql size:${slice}`,
      "-f",
      "per_page=100",
      "-f",
      `page=${page}`,
    ]);
    const body = JSON.parse(stdout) as {
      total_count: number;
      items: { path: string; repository: { full_name: string; fork: boolean } }[];
    };
    total = body.total_count;
    for (const item of body.items) {
      const hit: Hit = {
        repo: item.repository.full_name,
        path: item.path,
        fork: item.repository.fork,
        slice,
      };
      appendFileSync(RAW, `${JSON.stringify(hit)}\n`);
      repos[hit.repo] ??= { fork: hit.fork, slices: [], paths: 0 };
      const r = repos[hit.repo] as { fork: boolean; slices: string[]; paths: number };
      r.paths++;
      if (!r.slices.includes(slice)) r.slices.push(slice);
      hits++;
    }
    await sleep(PACE_MS);
    if (body.items.length < 100 || page * 100 >= total) break;
  }
  writeFileSync(OUT, JSON.stringify(repos, null, 1));
  console.log(
    `size:${slice}  ${total} files match, ${hits} fetched, ${Object.keys(repos).length} repositories so far`,
  );
  // Code search returns at most 1,000 results per query. A saturated slice is a partial frame:
  // narrow it, or describe the frame as "the first 1,000 hits" (as the N=1000 run does).
  if (hits < total)
    console.log(`  saturated: ${total - hits} matching files weren't returned for size:${slice}`);
}
