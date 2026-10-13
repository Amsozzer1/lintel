import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChecks } from "../../src/core/check.ts";
import { checkMigrations } from "../../src/core/ci.ts";
import { LintelError } from "../../src/core/errors.ts";
import type { Diff } from "../../src/core/findings.ts";
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

const newRules = (diff: Diff) => diff.new.map((f) => `${f.rule}:${f.object.name}`);

describe("checkMigrations", () => {
  it("reports the leak a PR introduces as new, and nothing else", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(LEAKY_MESSAGES);
    const { diff, base } = await checkMigrations({
      repoDir: repo.dir,
      baseRef: "base",
      headRef: head,
    });
    // The demo's blog is public by design; the probe proves it (warn) and it stays unchanged.
    expect(base.findings.map((f) => `${f.rule}:${f.object.name}:${f.level}`)).toEqual([
      "P001:blog_posts:warn",
    ]);
    const rules = diff.new.map((f) => `${f.rule}:${f.object.name}`);
    expect(rules).toContain("rls_disabled_in_public:messages");
    expect(rules).toContain("policy_exists_rls_disabled:messages");
    expect(rules).not.toContain("P001:messages"); // no seed rows yet
    expect(diff.unchanged.map((f) => f.rule)).toEqual(["P001"]);
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

  it("has the auth and storage schemas a real project has (Auth and Storage migrations)", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(
      `insert into storage.buckets (id, name, public, file_size_limit) values ('avatars', 'avatars', true, 1048576);
       create policy "avatars are public" on storage.objects for select using (bucket_id = 'avatars' and (storage.foldername(name))[1] is not null);
       create view public.user_providers as select user_id, provider from auth.identities;
       create table public.applied_marker (id int primary key);`,
      "20260903000000_storage.sql",
    );
    const { diff } = await checkMigrations({ repoDir: repo.dir, baseRef: "base", headRef: head });
    // The last statement only exists if the whole file applied.
    expect(newRules(diff)).toContain("rls_disabled_in_public:applied_marker");
  });

  it("applies each file in one transaction, with CREATE INDEX CONCURRENTLY on its own", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(
      `create temporary table staging on commit drop as select 1 as id;
       create table public.copied as select id from staging;
       create index concurrently copied_id_idx on public.copied (id);`,
      "20260903000000_tx.sql",
    );
    const { diff } = await checkMigrations({ repoDir: repo.dir, baseRef: "base", headRef: head });
    expect(newRules(diff)).toContain("rls_disabled_in_public:copied");
  });

  it("resets the session between files, like supabase db push", async () => {
    const repo = await demoRepo();
    await repo.commit(
      "select pg_catalog.set_config('search_path', '', false);",
      "20260903000000_dump.sql",
    );
    const head = await repo.commit(
      "create table public.tokens (id uuid primary key default uuid_generate_v4());",
      "20260904000000_tokens.sql",
    );
    const { diff } = await checkMigrations({ repoDir: repo.dir, baseRef: "base", headRef: head });
    expect(newRules(diff)).toContain("rls_disabled_in_public:tokens");
  });

  it("skips files Supabase wouldn't apply, and says so", async () => {
    const repo = await demoRepo();
    const head = await repo.commit("this is not sql;", "notes.sql");
    const { skipped } = await checkMigrations({
      repoDir: repo.dir,
      baseRef: "base",
      headRef: head,
    });
    expect(skipped).toEqual({ base: [], head: ["notes.sql"] });
  });

  it("names an object created outside migrations, with Postgres's error and the line", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(
      "-- adds an index\ncreate index contacts_email_idx on public.contacts (email);\n",
      "20260903000000_contacts.sql",
    );
    const err = (await checkMigrations({ repoDir: repo.dir, baseRef: "base", headRef: head }).catch(
      (e: unknown) => e,
    )) as LintelError;
    expect(err.code).toBe("LINTEL_E_MIGRATION");
    expect(err.message).toBe(
      "head@" +
        head.slice(0, 7) +
        ': migration 20260903000000_contacts.sql failed to apply (line 2): relation "public.contacts" does not exist',
    );
    expect(err.likelyCause).toContain("dashboard");
    expect(err.toJSON().migration).toMatchObject({
      file: "20260903000000_contacts.sql",
      statement: 1,
      line: 2,
      postgres: { code: "42P01", message: 'relation "public.contacts" does not exist' },
    });
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
