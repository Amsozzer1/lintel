/**
 * Apply migrations and the seed the way `supabase db push` does, on any engine that can run one
 * SQL statement at a time: node-postgres against a container, or PGlite in a browser.
 */
import { LintelError, type MigrationFailure } from "../errors.ts";
import {
  type Batch,
  migrationBatches,
  type Statement,
  seedBatches,
  trimLeadingComments,
} from "./statements.ts";

/** Run one statement over the simple query protocol. Rejects with the server's error. */
export type RunSql = (sql: string) => Promise<unknown>;

export interface SqlFile {
  name: string;
  sql: string;
}

/** The fields Postgres (and PGlite) put on an error. */
interface ServerError {
  message?: string;
  code?: string;
  detail?: string;
  hint?: string;
  where?: string;
  position?: string | number;
}

export interface ApplyOptions {
  /**
   * Statements that reset the session before each migration file. `supabase db push` runs
   * RESET ALL, so a dump's `set_config('search_path', '', false)` doesn't leak into the next file.
   */
  reset?: string[];
}

export async function applyMigration(
  run: RunSql,
  file: SqlFile,
  label: string,
  opts: ApplyOptions = {},
): Promise<void> {
  for (const sql of opts.reset ?? ["RESET ALL"]) await run(sql);
  await applyBatches(run, migrationBatches(file.sql), file, label, `migration ${file.name}`);
}

/** The seed runs right after the last migration, on the same session, with no reset (`SeedData`). */
export async function applySeed(run: RunSql, file: SqlFile, label: string): Promise<void> {
  await applyBatches(run, seedBatches(file.sql), file, label, file.name);
}

async function applyBatches(
  run: RunSql,
  batches: Batch[],
  file: SqlFile,
  label: string,
  what: string,
): Promise<void> {
  let index = 0;
  for (const batch of batches) {
    if (!batch.alone) await run("begin");
    for (const statement of batch.statements) {
      index++;
      try {
        await run(statement.text);
      } catch (err) {
        if (!batch.alone) await run("rollback").catch(() => {});
        throw failure(err, { file, label, what, statement, index });
      }
    }
    if (batch.alone) continue;
    try {
      await run("commit");
    } catch (err) {
      // Deferred constraints fail here, after every statement in the batch succeeded.
      await run("rollback").catch(() => {});
      throw failure(err, { file, label, what, index });
    }
  }
}

interface FailureContext {
  file: SqlFile;
  label: string;
  what: string;
  statement?: Statement;
  /** 1-based number of the statement in the file. */
  index: number;
}

function failure(err: unknown, ctx: FailureContext): LintelError {
  if (err instanceof LintelError) return err;
  const e = (err ?? {}) as ServerError;
  const message = e.message ?? String(err);
  // Without a position (most errors outside parsing), point at the statement's first line of SQL.
  const offset = !ctx.statement
    ? ctx.file.sql.length
    : ctx.statement.start +
      (Number(e.position) > 0
        ? charOffset(ctx.statement.text, Number(e.position))
        : ctx.statement.text.length - trimLeadingComments(ctx.statement.text).length);
  const { line, column } = lineAndColumn(ctx.file.sql, offset);
  const at = ctx.statement ? `line ${line}` : "commit";
  const migration: MigrationFailure = {
    file: ctx.file.name,
    statement: ctx.index,
    line,
    column,
    postgres: {
      message,
      ...(e.code ? { code: e.code } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.where ? { where: e.where } : {}),
    },
  };
  const explained = explain(e.code, message);
  return new LintelError(
    "LINTEL_E_MIGRATION",
    `${ctx.label}: ${ctx.what} failed to apply (${at}): ${message}`,
    {
      ...(explained?.cause ? { cause: explained.cause } : {}),
      next: explained?.next ?? "fix the migration, then re-run (locally: supabase db reset)",
      details: [
        `ERROR: ${message}${e.code ? ` (SQLSTATE ${e.code})` : ""}`,
        e.detail && `DETAIL: ${e.detail}`,
        e.hint && `HINT: ${e.hint}`,
        e.where && `CONTEXT: ${e.where}`,
        ctx.statement &&
          `at statement ${ctx.index}, line ${line}, column ${column} of ${ctx.file.name}:\n${excerpt(ctx.statement.text)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      migration,
    },
  );
}

/** Plain-words causes for the failures people hit on a fresh database. */
function explain(
  code: string | undefined,
  message: string,
): { cause: string; next?: string } | undefined {
  const missing: Record<string, string> = {
    "42P01": "relation",
    "42883": "function",
    "42704": "object",
    "3F000": "schema",
    "42703": "column",
  };
  const kind = code ? missing[code] : undefined;
  const type = /^type "([^"]+)" does not exist/.exec(message)?.[1];
  if (type) {
    return {
      cause: `type \`${type}\` isn't defined when this migration runs: the extension that provides it isn't enabled by an earlier migration, or it lives in a schema that isn't on the search_path (Supabase installs extensions in \`extensions\`).`,
      next: `enable the extension in an earlier migration, or schema-qualify it (e.g. extensions.${type})`,
    };
  }
  if (kind) {
    const column = /column "([^"]+)" of relation "([^"]+)"/.exec(message);
    const name = column
      ? `${column[2]}.${column[1]}`
      : (/"([^"]+)"/.exec(message)?.[1] ?? /^\w+ (.+) does not exist/.exec(message)?.[1] ?? kind);
    return {
      cause: `\`${name}\` doesn't exist when this migration runs, because no earlier migration creates it. It was most likely created in the Supabase dashboard (or by SQL run outside supabase/migrations), so a database built only from your migrations doesn't have it.`,
      next: "capture it in a migration: supabase db pull   (or: supabase db diff --linked -f <name>)",
    };
  }
  const ext = /extension "([^"]+)" is not available/.exec(message)?.[1];
  if (ext) {
    return {
      cause: `Supabase's Postgres 17 image, which Lintel replays into, doesn't ship the \`${ext}\` extension, so this migration can't run on a fresh Supabase database either.`,
      next: "check: select name from pg_available_extensions;   then drop the extension from your migrations or replace it",
    };
  }
  return undefined;
}

/** Postgres positions are 1-based and count characters, not UTF-16 units. */
function charOffset(text: string, position: number): number {
  let offset = 0;
  for (let n = 1; n < position && offset < text.length; n++) {
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return offset;
}

function lineAndColumn(sql: string, offset: number): { line: number; column: number } {
  const before = sql.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - before.lastIndexOf("\n") };
}

function excerpt(statement: string): string {
  const lines = statement.split("\n");
  const shown = lines.slice(0, 12).join("\n");
  const clipped = shown.length > 1200 ? `${shown.slice(0, 1200)}…` : shown;
  return lines.length > 12 && !clipped.endsWith("…") ? `${clipped}\n…` : clipped;
}
