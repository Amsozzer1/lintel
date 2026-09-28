import type pg from "pg";

export interface ExposedRelation {
  schema: string;
  name: string;
  /** r table · p partitioned table · v view · m materialized view */
  kind: "r" | "p" | "v" | "m";
  rls: boolean;
  /** Views run with their owner's rights unless security_invoker is set, which bypasses RLS. */
  securityInvoker: boolean;
}

/**
 * Relations `role` can read through PostgREST: in an exposed schema, with USAGE on the schema
 * and SELECT on the relation (or on any column). Extension-owned objects and partitions
 * (probed through their parent) are excluded.
 */
export async function exposedRelations(
  client: pg.Client,
  schemas: string[],
  role: "anon" | "authenticated",
): Promise<ExposedRelation[]> {
  const { rows } = await client.query<ExposedRelation>(
    `select n.nspname as schema,
            c.relname as name,
            c.relkind::text as kind,
            c.relrowsecurity as rls,
            coalesce('security_invoker=true' = any (c.reloptions)
                  or 'security_invoker=on' = any (c.reloptions), false) as "securityInvoker"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any ($1::text[])
        and c.relkind in ('r', 'p', 'v', 'm')
        and not c.relispartition
        and not exists (select 1 from pg_depend d
                         where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
        and has_schema_privilege($2, n.oid, 'USAGE')
        and (has_table_privilege($2, c.oid, 'SELECT') or has_any_column_privilege($2, c.oid, 'SELECT'))
      order by 1, 2`,
    [schemas, role],
  );
  return rows;
}
