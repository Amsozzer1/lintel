import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_stat_statements } from "@electric-sql/pglite/contrib/pg_stat_statements";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const here = new URL(".", import.meta.url).pathname;
const t0 = performance.now();
const CONTRIB = [
  "amcheck",
  "bloom",
  "btree_gin",
  "btree_gist",
  "citext",
  "cube",
  "dict_int",
  "dict_xsyn",
  "earthdistance",
  "fuzzystrmatch",
  "hstore",
  "intarray",
  "isn",
  "lo",
  "ltree",
  "moddatetime",
  "pg_buffercache",
  "pg_freespacemap",
  "pg_surgery",
  "pg_trgm",
  "pg_visibility",
  "pg_walinspect",
  "pgcrypto",
  "seg",
  "tablefunc",
  "tcn",
  "tsm_system_rows",
  "tsm_system_time",
  "unaccent",
  "uuid_ossp",
  "pg_stat_statements",
];
const contrib = Object.fromEntries(
  await Promise.all(
    CONTRIB.map(async (n) => [n, (await import(`@electric-sql/pglite/contrib/${n}`))[n]]),
  ),
);
const { vector } = await import("@electric-sql/pglite-pgvector");

export async function freshDb({ shims = true } = {}) {
  const db = await PGlite.create({
    extensions: shims ? { ...contrib, vector } : { pgcrypto, uuid_ossp, pg_stat_statements },
  });
  if (shims) {
    const FS = db.Module.FS,
      dir = "/pglite/share/postgresql/extension";
    for (const f of readdirSync(`${here}stubs`)) {
      const name = f.replace(/\.sql$/, "");
      FS.writeFile(
        `${dir}/${name}.control`,
        `comment = 'Lintel playground stub'\ndefault_version = '1.0'\nrelocatable = false\n`,
      );
      FS.writeFile(`${dir}/${name}--1.0.sql`, readFileSync(`${here}stubs/${f}`, "utf8"));
    }
  }
  await db.exec(readFileSync(`${here}bootstrap.sql`, "utf8"));
  await db.exec(readFileSync(`${here}auth-storage.sql`, "utf8"));
  await db.exec(`create or replace function auth.jwt() returns jsonb language sql stable as
    $f$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                        nullif(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
    grant execute on function auth.jwt() to anon, authenticated, service_role;`);
  if (shims) {
    await db.exec(readFileSync(`${here}hosted.sql`, "utf8"));
    await db.exec(`create extension supabase_vault with schema vault; create extension pg_graphql with schema graphql;
      alter database postgres set search_path = "$user", public, extensions; set search_path = "$user", public, extensions;`);
  }
  return db;
}

const LINTS = readFileSync(`${here}cli-lints.sql`, "utf8");
const sep = LINTS.indexOf(";\n\n");
const [setupSql, querySql] = [LINTS.slice(0, sep), LINTS.slice(sep + 3)];

export async function lints(db) {
  await db.exec("begin");
  try {
    await db.exec(setupSql);
    return (await db.query(querySql)).rows;
  } finally {
    await db.exec("rollback");
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const db = await freshDb();
  console.log("boot ms", (performance.now() - t0).toFixed(0));
  for (const f of process.argv.slice(2)) {
    try {
      await db.exec(readFileSync(f, "utf8"));
      console.log("applied", f.split("/").pop());
    } catch (e) {
      console.log("FAILED", f.split("/").pop(), e.message);
    }
  }
  const t1 = performance.now();
  const rows = await lints(db);
  console.log("lints ms", (performance.now() - t1).toFixed(0));
  for (const r of rows) console.log(r.level, r.name, `${r.metadata?.schema}.${r.metadata?.name}`);
}
