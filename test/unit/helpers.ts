import type { Finding, Report } from "../../src/core/findings.ts";

export function finding(overrides: Partial<Finding> & { fingerprint: string }): Finding {
  return {
    source: "advisor",
    rule: "rls_disabled_in_public",
    title: "RLS Disabled in Public",
    level: "error",
    object: { schema: "public", name: "t", kind: "table" },
    message: "Table `public.t` is public, but RLS has not been enabled.",
    ...overrides,
  };
}

export function report(findings: Finding[], label = "db"): Report {
  return {
    schema: "lintel.findings/v1",
    lintel_version: "0.0.0",
    target: { label },
    probes: { ran: false },
    findings,
  };
}
