/** Read a Supabase project's migrations and seed at a git ref, or from the working tree. */
import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { execa } from "execa";
import { LintelError } from "../errors.ts";

export interface SqlFile {
  name: string;
  sql: string;
}

export interface SupabaseFiles {
  /** Sorted by file name, which is how Supabase orders migrations. */
  migrations: SqlFile[];
  seed: string | undefined;
}

export async function readAtRef(
  repoDir: string,
  ref: string,
  supabaseDir: string,
): Promise<SupabaseFiles> {
  const commit = await git(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(
    () => "",
  );
  if (!commit.trim()) {
    throw new LintelError("LINTEL_E_GIT", `git ref \`${ref}\` was not found`, {
      cause: "the ref isn't fetched (CI checkouts are shallow by default)",
      next: `git fetch origin ${ref.replace(/^origin\//, "")}   (in Actions: actions/checkout with fetch-depth: 0)`,
    });
  }
  const dir = posix.join(supabaseDir, "migrations");
  const listing = await git(repoDir, [
    "ls-tree",
    "-r",
    "--name-only",
    commit.trim(),
    "--",
    `${dir}/`,
  ]);
  const paths = listing
    .split("\n")
    .filter((p) => p.endsWith(".sql") && posix.dirname(p) === posix.normalize(dir))
    .sort();
  const migrations = await Promise.all(
    paths.map(async (p) => ({
      name: posix.basename(p),
      sql: await git(repoDir, ["show", `${commit.trim()}:${p}`]),
    })),
  );
  const seed = await git(repoDir, [
    "show",
    `${commit.trim()}:${posix.join(supabaseDir, "seed.sql")}`,
  ]).catch(() => undefined);
  return { migrations, seed };
}

export async function readWorktree(repoDir: string, supabaseDir: string): Promise<SupabaseFiles> {
  const dir = join(repoDir, supabaseDir, "migrations");
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(dir, name), "utf8") })),
  );
  const seed = await readFile(join(repoDir, supabaseDir, "seed.sql"), "utf8").catch(
    () => undefined,
  );
  return { migrations, seed };
}

export async function shortSha(repoDir: string, ref: string): Promise<string> {
  return (await git(repoDir, ["rev-parse", "--short=7", ref]).catch(() => ref)).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false, stripFinalNewline: false });
  if (r.exitCode !== 0) {
    throw new LintelError("LINTEL_E_GIT", `git ${args[0]} failed`, { details: String(r.stderr) });
  }
  return String(r.stdout);
}
