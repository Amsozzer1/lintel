import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClient } from "../../src/core/db.ts";
import { runProbes } from "../../src/core/probes/index.ts";
import { type ManagedDb, startDb } from "../../src/core/replay/docker.ts";

describe("P001 anon_can_read", () => {
  let db: ManagedDb;
  beforeAll(async () => {
    db = await startDb();
    await db.psql(`
      create table public.leaky (id int primary key, secret text);
      insert into public.leaky values (1, 'a'), (2, 'b'), (3, 'c');

      create table public.open_policy (id int primary key);
      alter table public.open_policy enable row level security;
      create policy "all" on public.open_policy for select using (true);
      insert into public.open_policy values (1);

      create table public.locked (id int primary key, owner uuid);
      alter table public.locked enable row level security;
      create policy "own" on public.locked for select to authenticated using ((select auth.uid()) = owner);
      insert into public.locked values (1, gen_random_uuid());

      create table public.hidden_base (id int primary key);
      alter table public.hidden_base enable row level security;
      insert into public.hidden_base values (1);
      create view public.bypass as select * from public.hidden_base;

      create table public.empty_one (id int primary key);

      create table public."we""ird.name" (id int primary key);
      insert into public."we""ird.name" values (1);

      create schema private;
      create table private.not_exposed (id int primary key);
      insert into private.not_exposed values (1);
    `);
  });
  afterAll(async () => {
    await db?.stop();
  });

  it("proves each kind of leak with the right severity and stays silent otherwise", async () => {
    const { findings, unverified } = await runProbes(db.url, { schemas: ["public", "private"] });
    const got = Object.fromEntries(findings.map((f) => [f.object.name, [f.level, f.message]]));
    expect(got.leaky?.[0]).toBe("error");
    expect(got.leaky?.[1]).toContain("can read 3 rows");
    expect(got.leaky?.[1]).toContain("RLS is disabled");
    expect(got.open_policy?.[0]).toBe("warn");
    expect(got.bypass?.[0]).toBe("error");
    expect(got.bypass?.[1]).toContain("security_invoker");
    expect(got['we"ird.name']?.[0]).toBe("error");
    expect(got.locked).toBeUndefined();
    expect(got.hidden_base).toBeUndefined();
    expect(got.not_exposed).toBeUndefined(); // anon has no USAGE on schema private
    expect(unverified.map((u) => u.name)).toEqual(["empty_one"]);
  });

  it("leaves no trace: data unchanged and the session role restored", async () => {
    const before = await db.psql("select count(*) from public.leaky");
    await runProbes(db.url, { schemas: ["public"] });
    expect(await db.psql("select count(*) from public.leaky")).toBe(before);
    const role = await withClient(
      db.url,
      async (c) => (await c.query("select current_user")).rows[0],
    );
    expect(role).toEqual({ current_user: "postgres" });
  });
});
