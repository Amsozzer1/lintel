import { z } from "zod";

export const REPORT_SCHEMA = "lintel.findings/v1";
export const DIFF_SCHEMA = "lintel.diff/v1";

export const Level = z.enum(["error", "warn", "info"]).meta({
  description: "Severity. `error` fails CI by default.",
});
export type Level = z.infer<typeof Level>;

export const LEVEL_RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };

export const FailOn = z.enum(["error", "warn", "info", "none"]);
export type FailOn = z.infer<typeof FailOn>;

export const DbObject = z
  .object({
    schema: z.string().optional(),
    name: z.string().optional(),
    kind: z.string().optional(),
  })
  .meta({
    description:
      "The database object a finding is about. Values come from the database and are untrusted.",
  });

export const ProbeState = z.enum(["proven", "unverified_no_rows"]);

export const Finding = z
  .object({
    fingerprint: z
      .string()
      .meta({ description: "Stable identity across runs and databases. Never contains OIDs." }),
    source: z.enum(["advisor", "probe"]),
    rule: z.string().meta({
      description: "Advisor lint name (e.g. rls_disabled_in_public) or probe id (e.g. P001).",
    }),
    title: z.string(),
    level: Level,
    object: DbObject,
    message: z.string(),
    remediation: z.string().optional(),
    probe_state: ProbeState.optional(),
  })
  .meta({ id: "Finding" });
export type Finding = z.infer<typeof Finding>;

export const Report = z
  .object({
    schema: z.literal(REPORT_SCHEMA),
    lintel_version: z.string(),
    target: z.object({ label: z.string() }),
    probes: z.object({
      ran: z.boolean(),
      skipped_reason: z.string().optional(),
      unverified: z
        .array(z.object({ schema: z.string(), name: z.string(), reason: z.string() }))
        .optional()
        .meta({
          description: "Exposed relations a probe could not prove either way (e.g. no rows).",
        }),
    }),
    findings: z.array(Finding),
  })
  .meta({ id: "Report" });
export type Report = z.infer<typeof Report>;

export const Diff = z
  .object({
    schema: z.literal(DIFF_SCHEMA),
    new: z.array(Finding),
    resolved: z.array(Finding),
    unchanged: z.array(Finding),
  })
  .meta({ id: "Diff" });
export type Diff = z.infer<typeof Diff>;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.fingerprint.localeCompare(b.fingerprint),
  );
}

export function atOrAbove(findings: Finding[], failOn: FailOn): Finding[] {
  if (failOn === "none") return [];
  const min = LEVEL_RANK[failOn];
  return findings.filter((f) => LEVEL_RANK[f.level] >= min);
}
