import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../../src/core/check.ts";
import { checkMigrations } from "../../src/core/ci.ts";
import { LintelError } from "../../src/core/errors.ts";
import { type ManagedDb, startDb } from "../../src/core/replay/docker.ts";
import { demoRepo, FIXED_MESSAGES, LEAKY_MESSAGES } from "../helpers/repo.ts";

describe("throwaway Supabase database", () => {
  let db: ManagedDb;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db?.stop();
  });

  it("gives tables created as postgres Supabase's default grants to anon", async () => {
    await db.psql("create table public.grants_probe (id int primary key)");
    const out = await db.psql(
      "select has_table_privilege('anon', 'public.grants_probe', 'select')",
    );
    expect(out.trim()).toBe("t");
  });

  it("provides auth.uid() and auth.jwt()", async () => {
    const out = await db.psql(
      "select to_regprocedure('auth.uid()') is not null and to_regprocedure('auth.jwt()') is not null",
    );
    expect(out.trim()).toBe("t");
  });

  it("maps a wrong password to LINTEL_E_AUTH without echoing it", async () => {
    const bad = db.url.replace(/:[^:@]+@/, ":definitely-wrong-pw@");
    const err = await runChecks(bad, { label: "bad" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LintelError);
    expect((err as LintelError).code).toBe("LINTEL_E_AUTH");
    expect(
      JSON.stringify((err as LintelError).toJSON()) + (err as LintelError).details,
    ).not.toContain("definitely-wrong-pw");
  });
});

describe("checkMigrations", () => {
  it("reports the leak a PR introduces as new, and nothing else", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(LEAKY_MESSAGES);
    const { diff, base } = await checkMigrations({
      repoDir: repo.dir,
      baseRef: "base",
      headRef: head,
    });
    expect(base.findings).toEqual([]);
    const rules = diff.new.map((f) => `${f.rule}:${f.object.name}`);
    expect(rules).toContain("rls_disabled_in_public:messages");
    expect(rules).toContain("policy_exists_rls_disabled:messages");
    expect(diff.resolved).toEqual([]);
  });

  it("reports nothing new once the PR is fixed", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(FIXED_MESSAGES);
    const { diff } = await checkMigrations({ repoDir: repo.dir, baseRef: "base", headRef: head });
    expect(diff.new).toEqual([]);
  });

  it("fails with LINTEL_E_MIGRATION naming the broken file", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(
      "create table public.oops (id int references public.nope(id));",
      "20260903000000_broken.sql",
    );
    const err = await checkMigrations({ repoDir: repo.dir, baseRef: "base", headRef: head }).catch(
      (e: unknown) => e,
    );
    expect((err as LintelError).code).toBe("LINTEL_E_MIGRATION");
    expect((err as LintelError).message).toContain("20260903000000_broken.sql");
  });

  it("explains an unknown base ref", async () => {
    const repo = await demoRepo();
    const err = await checkMigrations({ repoDir: repo.dir, baseRef: "origin/nope" }).catch(
      (e: unknown) => e,
    );
    expect((err as LintelError).code).toBe("LINTEL_E_GIT");
    expect((err as LintelError).next).toContain("git fetch origin nope");
  });
});
