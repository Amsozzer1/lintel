import { describe, expect, it } from "vitest";
import { LintelError } from "../../src/core/errors.ts";
import { applyMigration, applySeed } from "../../src/core/supabase/apply.ts";
import { standaloneSessionReset, standaloneSetupSql } from "../../src/core/supabase/environment.ts";
import { describeSkipped, partitionMigrationFiles } from "../../src/core/supabase/files.ts";

/** A fake engine that records what it was sent and fails on statements matching `failOn`. */
function engine(failOn?: RegExp, error: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const run = async (sql: string) => {
    sent.push(sql);
    if (failOn?.test(sql)) throw { message: "boom", code: "XX000", ...error };
  };
  return { sent, run };
}

const failure = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(LintelError);
  return e as LintelError;
};

describe("applyMigration", () => {
  it("runs each file in one transaction, with CONCURRENTLY statements on their own", async () => {
    const { sent, run } = engine();
    await applyMigration(
      run,
      {
        name: "1_a.sql",
        sql: "create table a (id int);\ncreate index concurrently a_i on a (id);\nselect 1;",
      },
      "head",
    );
    expect(sent).toEqual([
      "RESET ALL",
      "begin",
      "create table a (id int)",
      "commit",
      "create index concurrently a_i on a (id)",
      "begin",
      "select 1",
      "commit",
    ]);
  });

  it("rolls back and reports the file, statement, line, column and Postgres's error", async () => {
    const sql = "create table a (id int);\n\n-- next\ninsert into nope values (1);\n";
    const { sent, run } = engine(/nope/, {
      message: 'relation "nope" does not exist',
      code: "42P01",
      position: "21", // counted from the start of the statement sent, which keeps its leading comment
    });
    const e = await failure(applyMigration(run, { name: "2_b.sql", sql }, "head@abc1234"));
    expect(sent.at(-1)).toBe("rollback");
    expect(sent[0]).toBe("RESET ALL");
    expect(e.code).toBe("LINTEL_E_MIGRATION");
    expect(e.message).toBe(
      'head@abc1234: migration 2_b.sql failed to apply (line 4): relation "nope" does not exist',
    );
    expect(e.migration).toEqual({
      file: "2_b.sql",
      statement: 2,
      line: 4,
      column: 13,
      postgres: { message: 'relation "nope" does not exist', code: "42P01" },
    });
    const json = e.toJSON();
    expect(json.migration).toEqual(e.migration);
    expect(json.details).toContain("SQLSTATE 42P01");
    expect(json.details).toContain("insert into nope values (1)");
  });

  it.each([
    ['relation "public.contacts" does not exist', "42P01", "`public.contacts`"],
    [
      'column "email_confirmed" of relation "users" does not exist',
      "42703",
      "`users.email_confirmed`",
    ],
    ["function public.score(integer) does not exist", "42883", "`public.score(integer)`"],
    ['schema "billing" does not exist', "3F000", "`billing`"],
  ])("says plainly that %s was created outside migrations", async (message, code, name) => {
    const { run } = engine(/x/, { message, code });
    const e = await failure(applyMigration(run, { name: "3_c.sql", sql: "select x;" }, "head"));
    expect(e.likelyCause).toContain(name);
    expect(e.likelyCause).toContain("dashboard");
    expect(e.next).toContain("supabase db pull");
  });

  it("names a missing role without sending people to db pull", async () => {
    const { run } = engine(/x/, { message: 'role "reporting" does not exist', code: "42704" });
    const e = await failure(applyMigration(run, { name: "7_g.sql", sql: "select x;" }, "head"));
    expect(e.likelyCause).toContain("`reporting`");
    expect(e.next).not.toContain("db pull");
  });

  it("doesn't blame the dashboard for other missing objects, such as a constraint", async () => {
    const { run } = engine(/x/, {
      message: 'constraint "c" of relation "t" does not exist',
      code: "42704",
    });
    const e = await failure(applyMigration(run, { name: "8_h.sql", sql: "select x;" }, "head"));
    expect(e.likelyCause).toBeUndefined();
  });

  it.each([
    [{ message: "Connection terminated unexpectedly", code: undefined }],
    [{ message: "terminating connection due to administrator command", code: "57P01" }],
    [{ message: "read ECONNRESET", code: "ECONNRESET" }],
  ])("reports a lost connection as a database problem, not a broken migration: %j", async (err) => {
    const { run } = engine(/x/, err);
    const e = await failure(applyMigration(run, { name: "9_i.sql", sql: "select x;" }, "head"));
    expect(e.code).toBe("LINTEL_E_DOCKER");
  });

  it("explains an extension the image doesn't ship", async () => {
    const { run } = engine(/timescaledb/, {
      message: 'extension "timescaledb" is not available',
      code: "0A000",
    });
    const e = await failure(
      applyMigration(run, { name: "4_d.sql", sql: "create extension timescaledb;" }, "head"),
    );
    expect(e.likelyCause).toContain("`timescaledb`");
  });

  it("points a missing type at extensions and the search_path, not the dashboard", async () => {
    const { run } = engine(/vector/, { message: 'type "vector" does not exist', code: "42704" });
    const e = await failure(
      applyMigration(run, { name: "5_e.sql", sql: "create table t (v vector(3));" }, "head"),
    );
    expect(e.likelyCause).toContain("search_path");
    expect(e.likelyCause).not.toContain("dashboard");
  });

  it("reports a failed commit (deferred constraints) as the commit", async () => {
    const { run } = engine(/^commit$/, {
      message: "violates foreign key constraint",
      code: "23503",
    });
    const e = await failure(applyMigration(run, { name: "6_f.sql", sql: "select 1;" }, "head"));
    expect(e.message).toContain("(commit)");
  });
});

describe("applySeed", () => {
  it("sends the seed as one transaction, without splitting statements out", async () => {
    const { sent, run } = engine();
    await applySeed(run, { name: "seed.sql", sql: "insert into a values (1);\nvacuum;" }, "head");
    expect(sent).toEqual(["begin", "insert into a values (1)", "vacuum", "commit"]);
  });
});

describe("migration file names", () => {
  it("applies only <digits>_name.sql, in name order, like Supabase", () => {
    expect(
      partitionMigrationFiles([
        "20240102_b.sql",
        "init.sql",
        "20240101_a.sql",
        "001_c.sql",
        ".keep",
        "v2_d.sql",
        "20240103.sql",
      ]),
    ).toEqual({
      apply: ["001_c.sql", "20240101_a.sql", "20240102_b.sql"],
      skipped: ["20240103.sql", "init.sql", "v2_d.sql"],
    });
  });

  it("lists skipped files, marking those on only one side", () => {
    expect(describeSkipped({ base: [], head: [] }, "supabase")).toBeUndefined();
    expect(describeSkipped({ base: ["init.sql"], head: ["init.sql", "new.sql"] }, "supabase")).toBe(
      "Skipped: Supabase only applies migration files named <digits>_name.sql, so Lintel didn't apply:\n" +
        "  supabase/migrations/init.sql\n" +
        "  supabase/migrations/new.sql (head only)",
    );
  });
});

describe("standaloneSetupSql", () => {
  it("keeps the engine's own postgres superuser and restores the image's search_path", () => {
    const sql = standaloneSetupSql();
    expect(sql[0]).not.toMatch(/^ALTER ROLE postgres WITH /m);
    expect(sql[0]).toMatch(/^CREATE ROLE anon;/m);
    expect(sql.slice(-2)).toEqual(standaloneSessionReset());
    expect(standaloneSessionReset()).toEqual([
      "RESET ALL",
      "SET search_path TO E'\\\\$user', 'public', 'extensions';",
    ]);
  });
});
