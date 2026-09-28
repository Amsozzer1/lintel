/**
 * P001 anon_can_read: prove what the public `anon` key can read, instead of inferring it.
 * Read-only, and always inside a transaction that is rolled back.
 */
import type pg from "pg";
import { probeFingerprint } from "../diff.ts";
import { DOCS_BASE } from "../errors.ts";
import type { Finding, Level } from "../findings.ts";
import { type ExposedRelation, exposedRelations } from "./exposure.ts";

const CAP = 1000;

export interface ProbeTarget {
  schema: string;
  name: string;
  reason: string;
}

export interface P001Result {
  findings: Finding[];
  unverified: ProbeTarget[];
}

export async function probeAnonRead(client: pg.Client, schemas: string[]): Promise<P001Result> {
  const findings: Finding[] = [];
  const unverified: ProbeTarget[] = [];
  for (const rel of await exposedRelations(client, schemas, "anon")) {
    const ident = `${client.escapeIdentifier(rel.schema)}.${client.escapeIdentifier(rel.name)}`;
    const count = `select count(*)::int as n from (select 1 from ${ident} limit ${CAP}) s`;
    await client.query("begin");
    try {
      await client.query("set local statement_timeout = '5s'; set local lock_timeout = '2s'");
      const total = (await client.query<{ n: number }>(count)).rows[0]?.n ?? 0;
      if (total === 0) {
        unverified.push({ schema: rel.schema, name: rel.name, reason: "no rows to probe" });
        continue;
      }
      await client.query("set local role anon");
      await client.query(
        `select set_config('request.jwt.claims', '{"role":"anon"}', true),
                set_config('request.jwt.claim.role', 'anon', true)`,
      );
      const visible = (await client.query<{ n: number }>(count)).rows[0]?.n ?? 0;
      if (visible > 0) findings.push(finding(rel, visible));
    } catch (err) {
      unverified.push({
        schema: rel.schema,
        name: rel.name,
        reason: `probe failed: ${(err as { code?: string }).code ?? "error"}`,
      });
    } finally {
      await client.query("rollback").catch(() => {});
    }
  }
  return { findings, unverified };
}

function finding(rel: ExposedRelation, visible: number): Finding {
  const rows = visible >= CAP ? `${CAP}+ rows` : `${visible} ${visible === 1 ? "row" : "rows"}`;
  const where = `\`${rel.schema}.${rel.name}\``;
  let level: Level;
  let why: string;
  if (rel.kind === "v" && !rel.securityInvoker) {
    level = "error";
    why = "through a view that bypasses RLS (security_invoker is off)";
  } else if (rel.kind === "m") {
    level = "error";
    why = "from a materialized view, which has no RLS";
  } else if (!rel.rls && (rel.kind === "r" || rel.kind === "p")) {
    level = "error";
    why = "because RLS is disabled";
  } else {
    level = "warn";
    why =
      "as allowed by its RLS policies. If this data is meant to be public, suppress this with a reason";
  }
  return {
    fingerprint: probeFingerprint("P001", rel.schema, rel.name),
    source: "probe",
    rule: "P001",
    title: "anon can read rows",
    level,
    object: { schema: rel.schema, name: rel.name, kind: KIND[rel.kind] },
    message: `Proved: the public anon key can read ${rows} from ${where} ${why}.`,
    remediation: `${DOCS_BASE}/probes.md#p001`,
    probe_state: "proven",
  };
}

const KIND = { r: "table", p: "table", v: "view", m: "materialized view" } as const;
