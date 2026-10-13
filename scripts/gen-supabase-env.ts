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
  // Format in memory, then write next to the target and rename: an interrupted run never leaves
  // a partial file.
  const formatted = await execa(
    "pnpm",
    ["exec", "biome", "format", `--stdin-file-path=${OUT.pathname}`],
    { input: source },
  );
  const tmp = new URL(`${OUT.href}.tmp`);
  await writeFile(
    tmp,
    formatted.stdout.endsWith("\n") ? formatted.stdout : `${formatted.stdout}\n`,
  );
  await rename(tmp, OUT);
  console.log(
    `wrote ${OUT.pathname}: auth ${authMigrations} migrations, storage ${storageMigrations} migrations`,
  );
} finally {
  await execa("docker", ["rm", "-f", db], { reject: false });
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
