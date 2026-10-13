/** Supabase only applies migration files named `<digits>_<name>.sql` (supabase/cli `migrateFilePattern`). */
export const MIGRATION_FILE = /^([0-9]+)_(.*)\.sql$/;

/** Split `.sql` file names into the ones Supabase applies, in its order, and the ones it skips. */
export function partitionMigrationFiles(names: string[]): { apply: string[]; skipped: string[] } {
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  return {
    apply: sql.filter((n) => MIGRATION_FILE.test(n)),
    skipped: sql.filter((n) => !MIGRATION_FILE.test(n)),
  };
}

/** A notice listing skipped files, or undefined when nothing was skipped. */
export function describeSkipped(
  skipped: { base: string[]; head: string[] },
  supabaseDir: string,
): string | undefined {
  const names = [...new Set([...skipped.base, ...skipped.head])].sort();
  if (!names.length) return undefined;
  const side = (n: string) =>
    !skipped.base.includes(n) ? " (head only)" : !skipped.head.includes(n) ? " (base only)" : "";
  return [
    "Skipped: Supabase only applies migration files named <digits>_name.sql, so Lintel didn't apply:",
    ...names.map((n) => `  ${supabaseDir}/migrations/${n}${side(n)}`),
  ].join("\n");
}
