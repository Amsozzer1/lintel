import { withClient } from "../db.ts";
import { applyMigration, applySeed } from "../supabase/apply.ts";
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
  await withClient(db.url, async (client) => {
    const run = (sql: string) => client.query(sql);
    for (const m of files.migrations) await applyMigration(run, m, label);
    if (files.seed?.trim()) await applySeed(run, { name: "seed.sql", sql: files.seed }, label);
  });
}
