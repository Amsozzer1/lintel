import { REPORT_SCHEMA, type Report, sortFindings } from "./findings.ts";
import { runAdvisors } from "./sources/advisors.ts";
import { LINTEL_VERSION } from "./version.ts";

export interface RunChecksOptions {
  /** Human label for the target. Never the connection string. */
  label: string;
  /** The database is a fresh replay: drop statistics-driven lints. */
  replay?: boolean;
  supabaseBin?: string;
}

export async function runChecks(dbUrl: string, opts: RunChecksOptions): Promise<Report> {
  const advisorFindings = await runAdvisors(dbUrl, {
    replay: opts.replay ?? false,
    ...(opts.supabaseBin ? { supabaseBin: opts.supabaseBin } : {}),
  });
  return {
    schema: REPORT_SCHEMA,
    lintel_version: LINTEL_VERSION,
    target: { label: opts.label },
    probes: { ran: false, skipped_reason: "probes are not enabled" },
    findings: sortFindings(advisorFindings),
  };
}
