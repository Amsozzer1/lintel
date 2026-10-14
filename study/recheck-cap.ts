/**
 * Recheck the 30-commit cap: replay a seeded random subsample of the over-cap repositories with no
 * cap, into study/private/raw-uncapped/. analyze.ts compares the two.
 *
 *   node study/recheck-cap.ts <raw dir> [count]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execa } from "execa";
import { rng, SEED } from "./random.ts";
import { MAX_COMMITS } from "./replay.ts";

const rawDir = process.argv[2] ?? "raw-n1000";
const COUNT = Number(process.argv[3] ?? 25);
const PRIVATE = new URL("private/", import.meta.url);
const sample = JSON.parse(readFileSync(new URL("sample.json", PRIVATE), "utf8")) as {
  repo: string;
}[];
const label = (i: number) => `repo-${String(i + 1).padStart(3, "0")}`;
const raw = new URL(`${rawDir}/`, PRIVATE);

const overCap = sample
  .map((s, i) => ({ id: label(i), file: new URL(`${s.repo.replace("/", "__")}.json`, raw) }))
  .filter((x) => existsSync(x.file))
  .filter((x) => (JSON.parse(readFileSync(x.file, "utf8")).commitsTouching ?? 0) > MAX_COMMITS)
  .map((x) => x.id);

const random = rng(SEED + 1);
const chosen = overCap
  .map((id) => ({ id, key: random() }))
  .sort((a, b) => a.key - b.key)
  .slice(0, COUNT)
  .map((x) => x.id)
  .sort();
console.log(`over-cap repositories: ${overCap.length}; rechecking ${chosen.length} uncapped`);
const already = existsSync(new URL("raw-uncapped/", PRIVATE))
  ? readdirSync(new URL("raw-uncapped/", PRIVATE)).length
  : 0;
if (already) console.log(`(${already} already done; resuming)`);
await execa(
  "node",
  [
    new URL("replay.ts", import.meta.url).pathname,
    "3",
    "--max",
    "100000",
    "--out",
    "raw-uncapped",
    "--only",
    chosen.join(","),
  ],
  { stdio: "inherit" },
);
