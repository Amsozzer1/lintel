import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Config } from "../../src/core/config.ts";
import { mcpToolsContract } from "../../src/mcp/contract.ts";
import { createServer } from "../../src/mcp/server.ts";

let client: Client;

beforeEach(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const config = Config.parse({ profiles: { staging: { url: "env:LINTEL_TEST_UNSET_URL" } } });
  client = new Client({ name: "test", version: "0" });
  await Promise.all([createServer(config).connect(b), client.connect(a)]);
});
afterEach(async () => {
  await client.close();
});

const text = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  (r.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

describe("MCP tools", () => {
  it("are all read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_migrations",
      "diff_databases",
      "explain_check",
      "list_checks",
      "run_checks",
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("match the committed contract (run: pnpm gen)", async () => {
    const committed = await readFile(
      new URL("../../schemas/mcp-tools.v1.json", import.meta.url),
      "utf8",
    );
    expect(await mcpToolsContract()).toBe(committed);
  });

  it("explain_check explains probes and Supabase lints", async () => {
    expect(
      text(await client.callTool({ name: "explain_check", arguments: { rule: "P001" } })),
    ).toContain("anon can read rows");
    const lint = await client.callTool({ name: "explain_check", arguments: { rule: "0013" } });
    expect((lint.structuredContent as { docs_url: string }).docs_url).toContain(
      "0013_rls_disabled_in_public",
    );
  });

  it("returns errors as tool errors with a next step, not crashes", async () => {
    const unknown = await client.callTool({ name: "explain_check", arguments: { rule: "nope" } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("list_checks");

    const profile = await client.callTool({ name: "run_checks", arguments: { profile: "prod" } });
    expect(profile.isError).toBe(true);
    expect(JSON.parse(text(profile)).error.code).toBe("LINTEL_E_USAGE");

    const unset = await client.callTool({ name: "run_checks", arguments: { profile: "staging" } });
    expect(JSON.parse(text(unset)).error.code).toBe("LINTEL_E_NO_DATABASE");
  });

  it("never accepts a connection string as a tool argument", async () => {
    const { tools } = await client.listTools();
    const params = tools.flatMap((t) => Object.keys((t.inputSchema.properties ?? {}) as object));
    expect(params.some((p) => /url|connection|password|dsn/i.test(p))).toBe(false);
  });
});
