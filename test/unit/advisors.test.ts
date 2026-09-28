import { describe, expect, it } from "vitest";
import {
  mapSupabaseError,
  normalizeLint,
  parseAdvisorOutput,
} from "../../src/core/sources/advisors.ts";

const lint = {
  name: "rls_disabled_in_public",
  title: "RLS Disabled in Public",
  level: "ERROR",
  facing: "EXTERNAL",
  categories: ["SECURITY"],
  description: "…",
  detail: "Table `public.spike` is public, but RLS has not been enabled.",
  remediation:
    "https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public",
  metadata: { name: "spike", type: "table", schema: "public" },
};

describe("parseAdvisorOutput", () => {
  it("accepts the {results:[…], cacheKey} shape", () => {
    const r = parseAdvisorOutput(
      JSON.stringify({ results: [{ ...lint, cacheKey: "k1" }], message: "db advisors" }),
    );
    expect("lints" in r && r.lints[0]?.cacheKey).toBe("k1");
  });

  it("accepts the bare array with cache_key shape", () => {
    const r = parseAdvisorOutput(JSON.stringify([{ ...lint, cache_key: "k2" }]));
    expect("lints" in r && r.lints[0]?.cacheKey).toBe("k2");
  });

  it("returns CLI errors as errors", () => {
    const r = parseAdvisorOutput(
      JSON.stringify({ _tag: "Error", error: { code: "DbConnectError", message: "boom" } }),
    );
    expect("error" in r && r.error.code).toBe("DbConnectError");
  });

  it("throws a documented error on non-JSON output", () => {
    expect(() => parseAdvisorOutput("Connecting…")).toThrow(/could not parse/);
  });
});

describe("normalizeLint", () => {
  it("lower-cases levels and fingerprints by cacheKey", () => {
    const f = normalizeLint({ ...lint, cacheKey: "rls_disabled_in_public_public_spike" });
    expect(f).toMatchObject({
      fingerprint: "advisor:rls_disabled_in_public_public_spike",
      level: "error",
      object: { schema: "public", name: "spike", kind: "table" },
    });
  });
});

describe("mapSupabaseError", () => {
  it.each([
    [
      "FATAL: password authentication failed for user (SQLSTATE 28P01)",
      "LINTEL_E_AUTH",
      "Session pooler",
    ],
    ["dial error (connect ECONNREFUSED 127.0.0.1:1)", "LINTEL_E_CONNECT", "supabase status"],
    ["dial tcp [2a05::1]:5432: connect: network is unreachable", "LINTEL_E_CONNECT", "pooler"],
    ["something else", "LINTEL_E_SUPABASE_CLI", undefined],
  ])("maps %s", (message, code, next) => {
    const e = mapSupabaseError({ code: "DbConnectError", message });
    expect(e.code).toBe(code);
    if (next) expect(e.next).toContain(next);
  });

  it("redacts passwords echoed in CLI errors", () => {
    const e = mapSupabaseError({ code: "X", message: "failed postgresql://u:hunter2@h/db" });
    expect(e.details).not.toContain("hunter2");
  });
});
