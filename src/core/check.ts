import { REPORT_SCHEMA, type Report, sortFindings } from "./findings.ts";
import { runProbes } from "./probes/index.ts";
import { runAdvisors } from "./sources/advisors.ts";
import { LINTEL_VERSION } from "./version.ts";

export interface RunChecksOptions {
  /** Human label for the target. Never the connection string. */
  label: string;
  /** Schemas PostgREST exposes (default: public). */
  schemas?: string[];
  /** Run Lintel's proof probes as well as Supabase's advisors. */
  probes?: boolean;
  /** The database is a fresh replay: drop statistics-driven lints. */
  replay?: boolean;
  supabaseBin?: string;
}

export async function runChecks(dbUrl: string, opts: RunChecksOptions): Promise<Report> {
  const [advisorFindings, probes] = await Promise.all([
    runAdvisors(dbUrl, {
      replay: opts.replay ?? false,
      ...(opts.supabaseBin ? { supabaseBin: opts.supabaseBin } : {}),
    }),
    opts.probes ? runProbes(dbUrl, { schemas: opts.schemas ?? ["public"] }) : undefined,
  ]);
  return {
    schema: REPORT_SCHEMA,
    lintel_version: LINTEL_VERSION,
    target: { label: opts.label },
    probes: probes
      ? { ran: true, ...(probes.unverified.length ? { unverified: probes.unverified } : {}) }
      : { ran: false, skipped_reason: "probes were not requested (use --probe)" },
    findings: sortFindings([...advisorFindings, ...(probes?.findings ?? [])]),
  };
}
