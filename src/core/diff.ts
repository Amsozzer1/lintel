import { DIFF_SCHEMA, type Diff, type Report, sortFindings } from "./findings.ts";

/** Compare two reports by fingerprint. Findings present only in head are new. */
export function diffReports(base: Report, head: Report): Diff {
  const baseKeys = new Set(base.findings.map((f) => f.fingerprint));
  const headKeys = new Set(head.findings.map((f) => f.fingerprint));
  return {
    schema: DIFF_SCHEMA,
    new: sortFindings(head.findings.filter((f) => !baseKeys.has(f.fingerprint))),
    resolved: sortFindings(base.findings.filter((f) => !headKeys.has(f.fingerprint))),
    unchanged: sortFindings(head.findings.filter((f) => baseKeys.has(f.fingerprint))),
  };
}

/** Fingerprint for Lintel's own findings: a JSON tuple of raw identifiers, so quoted names containing dots can't collide. */
export function probeFingerprint(rule: string, schema: string, name: string): string {
  return JSON.stringify([rule, schema, name]);
}
