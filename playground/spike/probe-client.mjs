export function pgClient(db) {
  return {
    escapeIdentifier: (s) => `"${s.replaceAll('"', '""')}"`,
    async query(sql, params) {
      if (params) return db.query(sql, params);
      const results = await db.exec(sql);
      return results.at(-1) ?? { rows: [] };
    },
  };
}
