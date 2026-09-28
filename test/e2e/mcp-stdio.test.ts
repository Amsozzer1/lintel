import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "../../dist/cli.js");

describe("lintel mcp over stdio", () => {
  it("writes only JSON-RPC to stdout, even when a tool fails", async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env });
    const send = (msg: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({
      id: 3,
      method: "tools/call",
      params: { name: "run_checks", arguments: { profile: "default" } },
    });
    await new Promise((r) => setTimeout(r, 1500));
    child.kill();
    const lines = stdout.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const call = lines.map((l) => JSON.parse(l)).find((m) => m.id === 3);
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("LINTEL_E_NO_DATABASE");
  });
});
