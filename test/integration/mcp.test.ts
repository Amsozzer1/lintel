import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Config } from "../../src/core/config.ts";
import { type ManagedDb, startDb } from "../../src/core/replay/docker.ts";
import { createServer } from "../../src/mcp/server.ts";
import { demoRepo, LEAKY_MESSAGES } from "../helpers/repo.ts";

describe("MCP against real databases", () => {
  let db: ManagedDb;
  let client: Client;
  beforeAll(async () => {
    db = await startDb();
    await db.psql(
      "create table public.leaky (id int primary key); insert into public.leaky values (1);",
    );
    process.env.LINTEL_MCP_TEST_URL = db.url;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    const config = Config.parse({ profiles: { local: { url: "env:LINTEL_MCP_TEST_URL" } } });
    await Promise.all([createServer(config).connect(b), client.connect(a)]);
  });
  afterAll(async () => {
    await client?.close();
    await db?.stop();
  });

  it("run_checks proves the leak and never returns the password", async () => {
    const r = await client.callTool({
      name: "run_checks",
      arguments: { profile: "local", probe: true },
    });
    const findings = (r.structuredContent as { findings: Array<{ rule: string }> }).findings;
    expect(findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["rls_disabled_in_public", "P001"]),
    );
    const password = decodeURIComponent(/:([^:@]+)@/.exec(db.url)?.[1] ?? "");
    expect(JSON.stringify(r)).not.toContain(password);
  });

  it("check_migrations answers 'is this migration safe?' and reports progress", async () => {
    const repo = await demoRepo();
    const head = await repo.commit(LEAKY_MESSAGES);
    const progress: string[] = [];
    const r = await client.callTool(
      {
        name: "check_migrations",
        arguments: { repo_dir: repo.dir, base_ref: "base", head_ref: head },
      },
      undefined,
      { onprogress: (p) => progress.push(p.message ?? ""), timeout: 240_000 },
    );
    expect(r.isError).toBeFalsy();
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/^NOT SAFE/);
    expect(text).toContain("rls_disabled_in_public");
    expect(progress.length).toBeGreaterThan(0);
  });
});
