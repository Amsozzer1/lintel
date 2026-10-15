/**
 * Replay again, in place, the commits that failed for an infrastructure reason (anything but a
 * migration error): a git read that failed under the replay, or a lost database connection.
 * A commit that fails the same way twice keeps its failure.
 *
 *   node study/repair.ts <raw dir> [concurrency]
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execa } from "execa";
import { LintelError, toLintelError } from "../src/core/errors.ts";
import { assertIsolated, startIsolatedDb } from "./isolated-db.ts";
import { type CommitResult, clone, replayCommit } from "./replay.ts";

const rawDir = process.argv[2] ?? "raw-n1000";
const concurrency = Number(process.argv[3] ?? 3);
const PRIVATE = new URL("private/", import.meta.url);
const RAW = new URL(`${rawDir}/`, PRIVATE);

interface Raw {
  repo: string;
  branch: string;
  error?: string;
  results: CommitResult[];
}

const infrastructure = (r: CommitResult) =>
  !r.applied && r.failure !== undefined && r.failure.code !== "LINTEL_E_MIGRATION";
const exposedTables = (r: CommitResult | undefined) =>
  r?.applied
    ? (r.exposed ?? [])
        .filter((e) => (e.kind === "r" || e.kind === "p") && !e.rls)
        .map((e) => e.name)
    : [];

const queue = readdirSync(RAW)
  .map((f) => ({
    file: new URL(f, RAW),
    raw: JSON.parse(readFileSync(new URL(f, RAW), "utf8")) as Raw,
  }))
  .filter((x) => !x.raw.error && x.raw.results.some(infrastructure));
const total = queue.reduce((n, x) => n + x.raw.results.filter(infrastructure).length, 0);
console.log(`${rawDir}: ${queue.length} repositories, ${total} commits to replay again`);

const leftovers = (await execa("docker", ["ps", "-aq", "--filter", "name=lintel-study-"])).stdout
  .split("\n")
  .filter(Boolean);
if (leftovers.length) await execa("docker", ["rm", "-f", ...leftovers], { reject: false });
const probe = await startIsolatedDb();
try {
  console.log(`isolation: ${await assertIsolated(probe.container)}`);
} finally {
  await probe.stop();
}

let done = 0;
let fixed = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { file, raw } = next;
      const headBefore = exposedTables(raw.results.at(-1));
      const dir = await clone(raw);
      for (const [i, r] of raw.results.entries()) {
        if (!infrastructure(r)) continue;
        let again: CommitResult;
        try {
          again = await replayCommit(dir, r.sha, r.date, r.index);
        } catch (err) {
          const e = err instanceof LintelError ? err : toLintelError(err);
          again = { ...r, failure: { code: e.code, message: e.message }, ms: 0 };
        }
        raw.results[i] = { ...again, ...(r.authorDate ? { authorDate: r.authorDate } : {}) };
        done++;
        if (!infrastructure(raw.results[i] as CommitResult)) fixed++;
      }
      writeFileSync(file, JSON.stringify(raw, null, 1));
      const head = raw.results.at(-1);
      const headAfter = exposedTables(head);
      if (head && headAfter.length && !headBefore.length)
        appendFileSync(
          new URL("disclosure-live.jsonl", PRIVATE),
          `${JSON.stringify({ repo: raw.repo, label: "repaired", sha: head.sha, committed: head.date, tables: headAfter })}\n`,
        );
      console.log(
        `${done}/${total} commits replayed again, ${fixed} no longer an infrastructure failure`,
      );
    }
  }),
);
console.log(`== repair done ${rawDir}: ${fixed}/${total} recovered`);
