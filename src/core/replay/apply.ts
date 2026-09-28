import { LintelError } from "../errors.ts";
import type { ManagedDb } from "./docker.ts";
import type { SupabaseFiles } from "./git.ts";

/**
 * Apply migrations, then the seed, as `postgres`: the role `supabase db push` uses.
 * Objects created by any other role would miss Supabase's default grants to anon/authenticated,
 * and exposure checks would silently pass.
 */
export async function applyFiles(
  db: ManagedDb,
  files: SupabaseFiles,
  label: string,
): Promise<void> {
  for (const m of files.migrations) {
    await db.psql(m.sql).catch((err: unknown) => {
      throw new LintelError("LINTEL_E_MIGRATION", `${label}: migration ${m.name} failed to apply`, {
        details: err instanceof Error ? err.message : String(err),
        next: "fix the migration, then re-run (locally: supabase db reset)",
      });
    });
  }
  if (files.seed?.trim()) {
    await db.psql(files.seed).catch((err: unknown) => {
      throw new LintelError("LINTEL_E_MIGRATION", `${label}: seed.sql failed to apply`, {
        details: err instanceof Error ? err.message : String(err),
        next: "fix supabase/seed.sql, then re-run",
      });
    });
  }
}
