/**
 * Supabase linter (splinter) rows to Lintel findings. No I/O, so every engine shares it: the CLI
 * parses `supabase db advisors` output into these rows, the playground gets them from the same SQL.
 */
import type { Finding, Level } from "../findings.ts";

/** Lints driven by runtime statistics. On a freshly replayed database they fire on every new index or table. */
export const REPLAY_DENYLIST: ReadonlySet<string> = new Set(["unused_index", "table_bloat"]);

export interface AdvisorLint {
  name: string;
  title: string;
  level: string;
  detail: string;
  remediation?: string;
  metadata: { schema?: string; name?: string; type?: string } | null;
  cacheKey: string;
}

/** One row as splinter or `supabase db advisors` returns it, in any of the shapes seen so far. */
export function toAdvisorLint(r: Record<string, unknown>): AdvisorLint {
  return {
    name: String(r.name ?? ""),
    title: String(r.title ?? r.name ?? ""),
    level: String(r.level ?? "info"),
    detail: String(r.detail ?? ""),
    ...(typeof r.remediation === "string" ? { remediation: r.remediation } : {}),
    metadata: isObject(r.metadata) ? (r.metadata as AdvisorLint["metadata"]) : null,
    cacheKey: String(r.cacheKey ?? r.cache_key ?? ""),
  };
}

export function normalizeLint(l: AdvisorLint): Finding {
  const level = l.level.toLowerCase();
  const object = {
    ...(l.metadata?.schema ? { schema: l.metadata.schema } : {}),
    ...(l.metadata?.name ? { name: l.metadata.name } : {}),
    ...(l.metadata?.type ? { kind: l.metadata.type } : {}),
  };
  return {
    fingerprint: `advisor:${l.cacheKey || JSON.stringify([l.name, object.schema, object.name])}`,
    source: "advisor",
    rule: l.name,
    title: l.title,
    level: (level === "error" || level === "warn" ? level : "info") satisfies Level,
    object,
    message: l.detail,
    ...(l.remediation ? { remediation: l.remediation } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
