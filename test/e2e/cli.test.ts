import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "../../dist/cli.js");

function lintel(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: undefined, NO_COLOR: "1", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("lintel CLI (built binary)", () => {
  it("documents every flag the docs promise", () => {
    const help = lintel(["check", "--help"]).stdout;
    for (const flag of ["--db", "--probe", "--schema", "--format", "--fail-on"])
      expect(help).toContain(flag);
    const mig = lintel(["migrations", "check", "--help"]).stdout;
    for (const flag of ["--base-ref", "--head-ref", "--supabase-dir", "--out-dir", "--fail-on"]) {
      expect(mig).toContain(flag);
    }
  });

  it.each([
    [["--help"], 0],
    [["--version"], 0],
    [["nope"], 2],
    [["check", "--bogus"], 2],
    [["check", "--format", "yaml"], 2],
    [["check", "--probe", "--db", "env:LINTEL_UNSET"], 2],
    [["explain", "nope"], 2],
    [["explain", "P001"], 0],
    [["diff", "missing-a.json", "missing-b.json"], 2],
    [["check", "--db", "postgresql://postgres:hunter2hunter2@127.0.0.1:1/postgres"], 3],
  ] as const)("lintel %j exits %i", (args, code) => {
    expect(lintel([...args]).code).toBe(code);
  });

  it("names the next command on errors", () => {
    const r = lintel(["check"]);
    expect(r.stderr).toContain("LINTEL_E_NO_DATABASE");
    expect(r.stderr).toContain("try: export DATABASE_URL=");
  });

  it("never prints a password, even one passed on the command line", () => {
    const r = lintel(["check", "--db", "postgresql://postgres:p@ss#w/rd-9x@127.0.0.1:1/postgres"]);
    expect(r.stdout + r.stderr).not.toMatch(/p@ss#w\/rd-9x|p%40ss/);
  });

  it("emits a JSON error envelope with --format json", () => {
    const r = lintel(["check", "--format", "json"]);
    expect(JSON.parse(r.stdout).error.code).toBe("LINTEL_E_NO_DATABASE");
  });
});
