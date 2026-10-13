import { beforeAll, describe, expect, it } from "vitest";
import { Engine, type Outcome } from "../src/engine.ts";
import { EXAMPLES } from "../src/examples.ts";
import { nodeAssets } from "./node-assets.ts";

const engine = new Engine(nodeAssets);
const example = (id: string) => {
  const e = EXAMPLES.find((x) => x.id === id);
  if (!e) throw new Error(id);
  return engine.run(e.migration, e.seed);
};
const rules = (o: Outcome) => {
  if (!o.ok) throw new Error(`${o.error.message}\n${o.error.details ?? ""}`);
  return o.report.findings.map((f) => `${f.rule}:${f.object.name}:${f.level}`);
};

beforeAll(() => engine.warmUp(), 120_000);

describe("playground examples", () => {
  it("leaky table: the P001 proof comes first, then the linter's finding", async () => {
    const o = await example("leaky");
    expect(rules(o)).toEqual(["P001:invoices:error", "rls_disabled_in_public:invoices:error"]);
    expect(o.ok && o.report.findings[0]?.message).toBe(
      "Proved: the public anon key can read 2 rows from `public.invoices` because RLS is disabled.",
    );
  });

  it("fixed table: nothing to report", async () => {
    const o = await example("fixed");
    expect(rules(o)).toEqual([]);
    expect(o.ok && o.report.probes.unverified).toBeUndefined();
  });

  it("using (true) for anon: P001 proves the read, the linter flags the insert policy", async () => {
    expect(rules(await example("true-for-anon"))).toEqual([
      "P001:feedback:warn",
      "rls_policy_always_true:feedback:warn",
    ]);
  });

  it("clean: nothing to report", async () => {
    expect(rules(await example("clean"))).toEqual([]);
  });
});

describe("engine", () => {
  it("reports an empty exposed table as unverified, never as passing", async () => {
    const o = await engine.run("create table public.notes (id int primary key, body text);", "");
    expect(rules(o)).toContain("rls_disabled_in_public:notes:error");
    expect(o.ok && o.report.probes.unverified).toEqual([
      { schema: "public", name: "notes", reason: "no rows to probe" },
    ]);
  });

  it("creates Supabase-only extensions from the generated stubs, where supautils puts them", async () => {
    const o = await engine.run(
      "create extension pg_cron with schema extensions;\nselect cron.schedule('nightly', '0 3 * * *', 'select 1');\ncreate extension pg_net;",
      "",
    );
    expect(rules(o)).not.toContain("extension_in_public:pg_cron:warn");
    expect(o.ok).toBe(true);
  });

  it("loads a native extension the SQL asks for", async () => {
    const o = await engine.run(
      "create extension vector with schema extensions;\ncreate table public.docs (id int primary key, embedding extensions.vector(3));\nalter table public.docs enable row level security;",
      "",
    );
    expect(rules(o)).toEqual(["rls_enabled_no_policy:docs:info"]);
  });

  it("says plainly when an extension can't run in the playground", async () => {
    const o = await engine.run("create extension postgis with schema extensions;", "");
    expect(o.ok).toBe(false);
    expect(!o.ok && o.error.cause).toContain("available on Supabase, but not in this playground");
    expect(!o.ok && o.error.hint).toContain("npx @amsozzer/lintel");
  });

  it("applies the file like supabase db push: CONCURRENTLY outside the transaction", async () => {
    const o = await engine.run(
      "create table public.t (id int primary key);\nalter table public.t enable row level security;\ncreate index concurrently t_id on public.t (id);",
      "",
    );
    expect(o.ok).toBe(true);
  });

  it("reports a broken migration with Postgres's error and the line", async () => {
    const o = await engine.run("-- one\ncreate table public.a (id int);\nselect * from nope;", "");
    expect(o.ok).toBe(false);
    expect(!o.ok && o.error.message).toBe(
      'playground: migration migration.sql failed to apply (line 3): relation "nope" does not exist',
    );
  });
});
