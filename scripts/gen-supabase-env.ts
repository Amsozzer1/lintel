/**
 * Regenerate src/core/supabase/environment.generated.ts. Needs Docker. Run it when bumping the
 * Postgres image or the Auth/Storage versions: `pnpm gen:supabase-env`.
 *
 * A bare supabase/postgres image has the auth and storage schemas from its own init scripts,
 * which are years behind a real project: Supabase Auth and Supabase Storage migrate them when
 * they start. This script starts Lintel's pinned image, lets both services run their own
 * migrations against it (the versions Supabase CLI v2.118.0 runs in `supabase start`), and dumps
 * the result. Nothing in the generated file is written by hand.
 */
import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import { DEFAULT_IMAGE, MANAGED_LABEL } from "../src/core/replay/docker.ts";

const AUTH = {
  version: "v2.197.0",
  image:
    "supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b",
  license: "MIT",
  source: "https://github.com/supabase/auth",
};
const STORAGE = {
  version: "v1.77.0",
  image:
    "supabase/storage-api:v1.77.0@sha256:3999cfa4f3286f945fa68069fc9b8b6bf3929a6bd53916dcf2e8c209801173c0",
  license: "Apache-2.0",
  source: "https://github.com/supabase/storage",
};
const OUT = new URL("../src/core/supabase/environment.generated.ts", import.meta.url);
const EXTENSIONS_OUT = new URL("../src/core/supabase/extensions.generated.ts", import.meta.url);
/** Member kinds a stub can't fake: they change how SQL parses or plans, not just what it calls. */
const UNSTUBBABLE_KINDS = [
  "pg_am",
  "pg_opclass",
  "pg_opfamily",
  "pg_operator",
  "pg_cast",
  "pg_collation",
  "pg_conversion",
  "pg_transform",
  "pg_ts_config",
  "pg_ts_dict",
  "pg_ts_parser",
  "pg_ts_template",
];
const PSEUDO_ARGS =
  /\b(internal|cstring|language_handler|fdw_handler|index_am_handler|table_am_handler|tsm_handler)\b/;
// Other member kinds (event triggers, foreign data wrappers, languages) only add behaviour; stubs leave them out.

const password = randomBytes(18).toString("base64url");
// Only signs nothing: both services refuse to start their config without one.
const jwtSecret = randomBytes(32).toString("base64url");
const env = { PGPASSWORD: password };

const db = (
  await execa(
    "docker",
    ["run", "-d", "--rm", "--label", MANAGED_LABEL, "-e", "POSTGRES_PASSWORD", DEFAULT_IMAGE],
    { env: { POSTGRES_PASSWORD: password } },
  )
).stdout.trim();

// `docker run -d` outlives this process: remove the container on Ctrl-C too, not just in `finally`.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void execa("docker", ["rm", "-f", db], { reject: false }).finally(() => process.exit(130));
  });
}

const psql = async (sql: string) =>
  (
    await execa(
      "docker",
      [
        "exec",
        "-i",
        "-e",
        "PGPASSWORD",
        db,
        "psql",
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        "127.0.0.1",
        "-U",
        "supabase_admin",
        "-d",
        "postgres",
      ],
      { input: sql, env },
    )
  ).stdout.trim();

const dump = async (tool: "pg_dump" | "pg_dumpall", args: string[]) => {
  const { stdout } = await execa(
    "docker",
    ["exec", "-e", "PGPASSWORD", db, tool, "-h", "127.0.0.1", "-U", "supabase_admin", ...args],
    { env, stripFinalNewline: false },
  );
  // pg_dump 17.6+ wraps dumps in psql-only \restrict lines; every engine here takes plain SQL.
  return stdout.replace(/^\\(un)?restrict .*\n/gm, "");
};

/** Run a service image's own migration command against `db`, sharing its network namespace. */
const migrate = (image: string, vars: Record<string, string>, flags: string[], command: string[]) =>
  execa(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      `container:${db}`,
      ...Object.keys(vars).flatMap((k) => ["-e", k]),
      ...flags,
      image,
      ...command,
    ],
    { env: vars, stdout: "ignore", stderr: "inherit" },
  );

try {
  await waitReady();
  await psql(
    `alter role supabase_auth_admin password '${password}';
     alter role supabase_storage_admin password '${password}';`,
  );
  const url = (role: string) => `postgres://${role}:${password}@127.0.0.1:5432/postgres`;

  console.log(`migrating auth with ${AUTH.image}`);
  await migrate(
    AUTH.image,
    {
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_DB_DATABASE_URL: url("supabase_auth_admin"),
      GOTRUE_SITE_URL: "http://localhost:3000",
      API_EXTERNAL_URL: "http://localhost:54321",
      GOTRUE_JWT_SECRET: jwtSecret,
    },
    [],
    ["auth", "migrate"],
  );

  console.log(`migrating storage with ${STORAGE.image}`);
  await migrate(
    STORAGE.image,
    {
      DATABASE_URL: url("supabase_storage_admin"),
      AUTH_JWT_SECRET: jwtSecret,
      ANON_KEY: "unused",
      SERVICE_KEY: "unused",
      TENANT_ID: "stub",
      STORAGE_BACKEND: "file",
      FILE_STORAGE_BACKEND_PATH: "/tmp",
      GLOBAL_S3_BUCKET: "stub",
      REGION: "stub",
      STORAGE_S3_REGION: "stub",
      VECTOR_ENABLED: "false",
    },
    ["--entrypoint", "node"],
    ["dist/scripts/migrate-call.js"],
  );

  const authMigrations = Number(await psql("select count(*) from auth.schema_migrations"));
  const storageMigrations = Number(await psql("select count(*) from storage.migrations"));
  const hosted = await dump("pg_dump", [
    "-d",
    "postgres",
    "--schema-only",
    "-n",
    "auth",
    "-n",
    "storage",
  ]);
  const roles = await dump("pg_dumpall", ["--roles-only", "--no-role-passwords"]);
  const base = await dump("pg_dump", [
    "-d",
    "postgres",
    "--schema-only",
    "-N",
    "auth",
    "-N",
    "storage",
  ]);

  const meta = {
    postgres: DEFAULT_IMAGE,
    auth: { ...AUTH, migrations: authMigrations },
    storage: { ...STORAGE, migrations: storageMigrations },
  };
  const source = `// Generated by scripts/gen-supabase-env.ts (\`pnpm gen:supabase-env\`). Do not edit by hand.
//
// Supabase Auth ${AUTH.version} (${AUTH.license}, ${AUTH.source}) and Supabase Storage
// ${STORAGE.version} (${STORAGE.license}, ${STORAGE.source}) ran their own migrations against
// ${DEFAULT_IMAGE.split("@")[0]}; these are dumps of the result.

export const SUPABASE_ENVIRONMENT = ${JSON.stringify(meta, null, 2)} as const;

/** The \`auth\` and \`storage\` schemas after Auth and Storage migrated them (pg_dump --schema-only). */
export const HOSTED_SCHEMA_SQL: string = ${JSON.stringify(hosted)};

/** The image's roles (pg_dumpall --roles-only --no-role-passwords). */
export const IMAGE_ROLES_SQL: string = ${JSON.stringify(roles)};

/** The rest of the image's database: schemas, extensions, grants, event triggers (pg_dump --schema-only). */
export const IMAGE_BASE_SQL: string = ${JSON.stringify(base)};
`;
  await writeGenerated(OUT, source);
  console.log(
    `wrote ${OUT.pathname}: auth ${authMigrations} migrations, storage ${storageMigrations} migrations`,
  );

  // After the dumps, so creating extensions doesn't change them.
  const { stubs, unsupported, available, overrides } = await extensionStubs();
  await writeGenerated(
    EXTENSIONS_OUT,
    `// Generated by scripts/gen-supabase-env.ts (\`pnpm gen:supabase-env\`). Do not edit by hand.
//
// For engines without the image (the playground): every extension ${DEFAULT_IMAGE.split("@")[0]}
// ships, created in the image and read back from its catalog. Each stub has the extension's
// schemas, types, tables, views and function signatures, with bodies that do nothing.

/** Extension names in the image's pg_available_extensions. */
export const IMAGE_EXTENSIONS: readonly string[] = ${JSON.stringify(available)};

/** \`supautils.extensions_parameter_overrides\` from the image's config. */
export const SUPAUTILS_EXTENSION_OVERRIDES: Readonly<Record<string, { schema?: string }>> = ${JSON.stringify(overrides)};

export interface ExtensionStub {
  /** The control file's fixed \`schema\`, if any. */
  schema?: string;
  requires: string[];
  /** The install script, with \`@extschema@\` where the extension's own schema goes. */
  sql: string;
}

export const EXTENSION_STUBS: Readonly<Record<string, ExtensionStub>> = ${JSON.stringify(stubs)};

/** Extensions a no-op stub can't stand in for, and why. Whether an engine has them natively is up to the engine. */
export const UNSTUBBABLE_EXTENSIONS: Readonly<Record<string, string>> = ${JSON.stringify(unsupported)};
`,
  );
  console.log(
    `wrote ${EXTENSIONS_OUT.pathname}: ${Object.keys(stubs).length} stubs, ${Object.keys(unsupported).length} unsupported`,
  );
} finally {
  await execa("docker", ["rm", "-f", db], { reject: false });
}

/** Format in memory, then write next to the target and rename: an interrupted run never leaves a partial file. */
async function writeGenerated(target: URL, source: string): Promise<void> {
  const formatted = (
    await execa("pnpm", ["exec", "biome", "format", `--stdin-file-path=${target.pathname}`], {
      input: source,
    })
  ).stdout;
  const tmp = new URL(`${target.href}.tmp`);
  await writeFile(tmp, formatted.endsWith("\n") ? formatted : `${formatted}\n`);
  await rename(tmp, target);
}

interface Members {
  schemas: string[] | null;
  types:
    | {
        schema: string;
        name: string;
        kind: string;
        labels: string[] | null;
        base: string | null;
        attrs: { name: string; type: string }[] | null;
      }[]
    | null;
  relations:
    | {
        schema: string;
        name: string;
        kind: string;
        attrs: { name: string; type: string }[] | null;
      }[]
    | null;
  functions:
    | {
        schema: string;
        name: string;
        kind: string;
        args: string;
        result: string | null;
        retset: boolean;
      }[]
    | null;
  other: string[] | null;
}

async function extensionStubs() {
  const available = (
    await psql("select string_agg(name, ',' order by name) from pg_available_extensions")
  ).split(",");
  const overridesLine = (
    await execa("docker", [
      "exec",
      db,
      "sh",
      "-c",
      "grep -rhE '^supautils.extensions_parameter_overrides' /etc/postgresql-custom /etc/postgresql 2>/dev/null | head -1",
    ])
  ).stdout;
  const overrides = JSON.parse(/'(.*)'/.exec(overridesLine)?.[1] ?? "{}");
  const sharedir = (await execa("docker", ["exec", db, "pg_config", "--sharedir"])).stdout.trim();
  await psql("create schema lintel_extschema");

  const stubs: Record<string, { schema?: string; requires: string[]; sql: string }> = {};
  const unsupported: Record<string, string> = {};
  for (const name of available) {
    const control = (
      await execa("docker", ["exec", db, "cat", `${sharedir}/extension/${name}.control`])
    ).stdout;
    const param = (key: string) =>
      new RegExp(`^${key}\\s*=\\s*'?([^'\\n]*)'?`, "m").exec(control)?.[1]?.trim();
    const schema = param("schema");
    const requires = (param("requires") ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const created = await psql(
      `create extension if not exists "${name}" ${schema ? "" : "with schema lintel_extschema"} cascade; select 'ok'`,
    ).catch((e: { stderr?: string }) => String(e.stderr ?? e));
    if (!created.endsWith("ok")) {
      unsupported[name] =
        `can't be created in the image without extra setup: ${created.split("\n").find((l) => l.startsWith("ERROR")) ?? created}`;
      continue;
    }
    const m = JSON.parse(await psql(membersSql(name))) as Members;
    const blocking = (m.other ?? []).filter((k) => UNSTUBBABLE_KINDS.includes(k));
    const baseTypes = (m.types ?? []).filter((t) => !["c", "e", "d"].includes(t.kind));
    if (blocking.length || baseTypes.length) {
      unsupported[name] = blocking.length
        ? `defines ${blocking.join(", ").replaceAll("pg_", "")}, which change how SQL parses and plans`
        : `defines its own base types (${baseTypes.map((t) => t.name).join(", ")})`;
      continue;
    }
    stubs[name] = { ...(schema ? { schema } : {}), requires, sql: stubSql(m) };
  }
  // A stub that uses another extension's types needs that extension, declared or not.
  const typeOwners = JSON.parse(
    await psql(`select coalesce(json_object_agg(t.typname, e.extname), '{}') from pg_depend d
      join pg_extension e on e.oid = d.refobjid join pg_type t on t.oid = d.objid
     where d.classid = 'pg_type'::regclass and d.deptype = 'e' and t.typtype in ('b', 'r', 'm')
       and t.typcategory <> 'A'`),
  ) as Record<string, string>;
  for (const [name, stub] of Object.entries(stubs)) {
    for (const [type, owner] of Object.entries(typeOwners)) {
      if (
        owner !== name &&
        !stub.requires.includes(owner) &&
        new RegExp(`(^|[\\s.(,])${type}\\b`).test(stub.sql)
      )
        stub.requires.push(owner);
    }
    stub.requires.sort();
  }
  return { stubs, unsupported, available, overrides };
}

function membersSql(name: string): string {
  return `with m as (
    select d.classid, d.objid from pg_depend d join pg_extension e on e.oid = d.refobjid
     where e.extname = '${name}' and d.deptype = 'e')
  select json_build_object(
    'schemas', (select json_agg(n.nspname order by n.oid) from m join pg_namespace n on m.classid = 'pg_namespace'::regclass and n.oid = m.objid),
    'types', (select json_agg(json_build_object('schema', t.typnamespace::regnamespace::text, 'name', t.typname, 'kind', t.typtype,
        'labels', (select json_agg(enumlabel order by enumsortorder) from pg_enum where enumtypid = t.oid),
        'base', case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end,
        'attrs', case when t.typtype = 'c' then (select json_agg(json_build_object('name', quote_ident(a.attname), 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                   from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped) end) order by t.oid)
      from m join pg_type t on m.classid = 'pg_type'::regclass and t.oid = m.objid
     where not (t.typcategory = 'A' and t.typelem <> 0)
       -- a table's row type is a member too; the table creates it
       and (t.typtype <> 'c' or (select relkind from pg_class where oid = t.typrelid) = 'c')),
    'relations', (select json_agg(json_build_object('schema', c.relnamespace::regnamespace::text, 'name', c.relname, 'kind', c.relkind,
        'attrs', (select json_agg(json_build_object('name', quote_ident(a.attname), 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                    from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) order by c.oid)
      from m join pg_class c on m.classid = 'pg_class'::regclass and c.oid = m.objid where c.relkind in ('r', 'p', 'v', 'm', 'S')),
    'functions', (select json_agg(json_build_object('schema', p.pronamespace::regnamespace::text, 'name', p.proname, 'kind', p.prokind,
        'args', pg_get_function_arguments(p.oid), 'result', pg_get_function_result(p.oid), 'retset', p.proretset) order by p.oid)
      from m join pg_proc p on m.classid = 'pg_proc'::regclass and p.oid = m.objid),
    'other', (select json_agg(distinct m.classid::regclass::text) from m
      where m.classid not in ('pg_namespace'::regclass, 'pg_type'::regclass, 'pg_class'::regclass, 'pg_proc'::regclass)))`;
}

/** DDL with the same names and signatures as the extension, and bodies that do nothing. */
function stubSql(m: Members): string {
  const q = (schema: string, name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const out: string[] = [];
  for (const s of m.schemas ?? []) out.push(`create schema ${quoteIdent(s)};`);
  for (const t of m.types ?? []) {
    if (t.kind === "e")
      out.push(
        `create type ${q(t.schema, t.name)} as enum (${(t.labels ?? []).map(quoteLiteral).join(", ")});`,
      );
    else if (t.kind === "d") out.push(`create domain ${q(t.schema, t.name)} as ${t.base};`);
    else
      out.push(
        `create type ${q(t.schema, t.name)} as (${(t.attrs ?? []).map((a) => `${a.name} ${a.type}`).join(", ")});`,
      );
  }
  const rels = m.relations ?? [];
  for (const r of rels.filter((r) => r.kind === "S"))
    out.push(`create sequence ${q(r.schema, r.name)};`);
  for (const r of rels.filter((r) => r.kind === "r" || r.kind === "p"))
    out.push(
      `create table ${q(r.schema, r.name)} (${(r.attrs ?? []).map((a) => `${a.name} ${a.type}`).join(", ")});`,
    );
  for (const f of m.functions ?? []) {
    // Aggregates, window functions and C-level support functions can't be written in plpgsql;
    // nothing a migration calls directly.
    if (f.kind === "a" || f.kind === "w" || PSEUDO_ARGS.test(`${f.args} ${f.result ?? ""}`))
      continue;
    const name = q(f.schema, f.name);
    if (f.kind === "p") {
      out.push(
        `create procedure ${name}(${f.args}) language plpgsql as $lintel$ begin end $lintel$;`,
      );
      continue;
    }
    const result = f.result ?? "void";
    const body =
      result === "void" || result === "event_trigger"
        ? ""
        : result === "trigger"
          ? "return null;"
          : f.retset || /^TABLE\(/.test(result) || /\b(OUT|INOUT) /.test(f.args)
            ? "return;"
            : "return null;";
    out.push(
      `create function ${name}(${f.args}) returns ${result} language plpgsql as $lintel$ begin ${body} end $lintel$;`,
    );
  }
  for (const r of rels.filter((r) => r.kind === "v" || r.kind === "m"))
    out.push(
      `create view ${q(r.schema, r.name)} as select ${(r.attrs ?? []).map((a) => `null::${a.type} as ${a.name}`).join(", ")};`,
    );
  // Objects created in the placeholder schema belong in whatever schema the extension is created in.
  return out
    .join("\n")
    .replaceAll('"lintel_extschema"', "@extschema@")
    .replaceAll("lintel_extschema.", "@extschema@.");
}

function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`;
}

function quoteLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** Same readiness rule as replay: the `authenticated` role exists and the server stopped restarting. */
async function waitReady(): Promise<void> {
  let last = "";
  for (let i = 0; i < 240; i++) {
    const start = await psql(
      "select pg_postmaster_start_time()::text from pg_roles where rolname = 'authenticated'",
    ).catch(() => "");
    if (start && start === last) return;
    last = start;
    await sleep(start ? 1500 : 500);
  }
  throw new Error("the database container did not become ready");
}
