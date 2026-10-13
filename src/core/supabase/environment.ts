/**
 * The Supabase database Lintel replays migrations into, for every engine: the pinned
 * supabase/postgres image, with `auth` and `storage` as Supabase Auth and Storage leave them.
 * The SQL is generated from Supabase's own migrations (see environment.generated.ts).
 */
import {
  HOSTED_SCHEMA_SQL,
  IMAGE_BASE_SQL,
  IMAGE_ROLES_SQL,
  SUPABASE_ENVIRONMENT,
} from "./environment.generated.ts";

export { SUPABASE_ENVIRONMENT };

/**
 * Run as `supabase_admin` on a fresh container of the pinned image: swap its init-script `auth`
 * and `storage` for the migrated ones. Dropping them cascades only to objects inside the two schemas.
 */
export const CONTAINER_SETUP_SQL = `drop schema if exists auth cascade;
drop schema if exists storage cascade;
${HOSTED_SCHEMA_SQL}`;

/**
 * The same database for an engine without the image (PGlite): the image's roles, schemas and
 * grants, then the migrated `auth` and `storage`. Run each script in order as the engine's
 * superuser `postgres`. It stays a superuser (the image's `postgres` is not), so some statements
 * succeed here that the image refuses. Extensions the engine lacks, such as `pg_graphql` and
 * `supabase_vault`, must be available before this runs.
 */
export function standaloneSetupSql(): string[] {
  const roles = IMAGE_ROLES_SQL.split("\n")
    .filter((l) => !/^(CREATE ROLE postgres;|ALTER ROLE postgres WITH )/.test(l))
    // The image's bootstrap superuser is supabase_admin; here it is postgres, and Postgres only
    // accepts memberships recorded as granted by the bootstrap superuser (or a role with ADMIN).
    .map((l) => (l.startsWith("GRANT ") ? l.replace(/ GRANTED BY \S+;$/, ";") : l))
    .join("\n");
  return [roles, IMAGE_BASE_SQL, HOSTED_SCHEMA_SQL, ...standaloneSessionReset()];
}

/**
 * The session reset before each migration file on an engine without the image. RESET ALL alone
 * would fall back to the server default search_path: the engine's single session started before
 * the image's `ALTER ROLE postgres SET search_path` existed.
 */
export function standaloneSessionReset(): string[] {
  return ["RESET ALL", postgresSearchPath()];
}

/** The dumps leave search_path empty. Restore what the image sets for `postgres`. */
function postgresSearchPath(): string {
  const value = /^ALTER ROLE postgres SET search_path TO (.+);$/m.exec(IMAGE_ROLES_SQL)?.[1];
  if (!value) throw new Error("environment.generated.ts has no search_path for postgres");
  return `SET search_path TO ${value};`;
}
