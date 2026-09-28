/**
 * What Lintel checks. Static lints come from Supabase's advisors (splinter); probes are Lintel's own.
 * The lint list is used for `explain` and discovery only; findings always come from the live CLI.
 */
import { DOCS_BASE } from "./errors.ts";
import type { Level } from "./findings.ts";

export interface ProbeInfo {
  id: string;
  title: string;
  levels: Level[];
  summary: string;
  docs_url: string;
}

export const PROBES: ProbeInfo[] = [
  {
    id: "P001",
    title: "anon can read rows",
    levels: ["error", "warn"],
    summary:
      "Counts the rows the public anon role can SELECT from each exposed table, view and materialized view, inside a rolled-back transaction. error when RLS is off or bypassed (views without security_invoker, materialized views); warn when a policy allows it.",
    docs_url: `${DOCS_BASE}/probes.md#p001`,
  },
];

/** Supabase database linter (splinter) lints, by number. */
export const ADVISOR_LINTS: ReadonlyArray<readonly [number: string, name: string]> = [
  ["0001", "unindexed_foreign_keys"],
  ["0002", "auth_users_exposed"],
  ["0003", "auth_rls_initplan"],
  ["0004", "no_primary_key"],
  ["0005", "unused_index"],
  ["0006", "multiple_permissive_policies"],
  ["0007", "policy_exists_rls_disabled"],
  ["0008", "rls_enabled_no_policy"],
  ["0009", "duplicate_index"],
  ["0010", "security_definer_view"],
  ["0011", "function_search_path_mutable"],
  ["0013", "rls_disabled_in_public"],
  ["0014", "extension_in_public"],
  ["0015", "rls_references_user_metadata"],
  ["0016", "materialized_view_in_api"],
  ["0017", "foreign_table_in_api"],
  ["0018", "unsupported_reg_types"],
  ["0019", "insecure_queue_exposed_in_api"],
  ["0020", "table_bloat"],
  ["0021", "fkey_to_auth_unique"],
  ["0022", "extension_versions_outdated"],
  ["0023", "sensitive_columns_exposed"],
  ["0024", "rls_policy_always_true"],
  ["0025", "public_bucket_allows_listing"],
  ["0026", "pg_graphql_anon_table_exposed"],
  ["0027", "pg_graphql_authenticated_table_exposed"],
  ["0028", "anon_security_definer_function_executable"],
  ["0029", "authenticated_security_definer_function_executable"],
  ["0030", "autovacuum_disabled"],
];

export interface Explanation {
  rule: string;
  source: "probe" | "advisor";
  title: string;
  summary: string;
  docs_url: string;
}

export function explain(rule: string): Explanation | undefined {
  const probe = PROBES.find((p) => p.id.toLowerCase() === rule.toLowerCase());
  if (probe) {
    return {
      rule: probe.id,
      source: "probe",
      title: probe.title,
      summary: probe.summary,
      docs_url: probe.docs_url,
    };
  }
  const lint = ADVISOR_LINTS.find(
    ([n, name]) => name === rule || n === rule || `${n}_${name}` === rule,
  );
  if (lint) {
    const [n, name] = lint;
    return {
      rule: name,
      source: "advisor",
      title: name.replaceAll("_", " "),
      summary: `Supabase database linter lint ${n}. Lintel reports it as-is from \`supabase db advisors\`; the linked page explains the risk and the fix.`,
      docs_url: `https://supabase.com/docs/guides/database/database-linter?lint=${n}_${name}`,
    };
  }
  return undefined;
}
