/** Split SQL into statements the way psql sends them: aware of quotes, dollar quotes, comments and BEGIN ATOMIC. */
export function splitSql(sql) {
  const out = [];
  let start = 0,
    i = 0,
    depth = 0;
  const n = sql.length;
  const word = (at) => /^[A-Za-z_]+/.exec(sql.slice(at))?.[0]?.toLowerCase();
  while (i < n) {
    const c = sql[i],
      d = sql[i + 1];
    if (c === "-" && d === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === "/" && d === "*") {
      let lvl = 1;
      i += 2;
      while (i < n && lvl) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          lvl++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          lvl--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        if (c === "'" && sql[i] === "\\" && /[eE]$/.test(`${sql.slice(0, start + 0)}`)) i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c) && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      const w = word(i);
      if (w === "atomic" && /begin\s+$/i.test(sql.slice(Math.max(0, i - 12), i))) depth++;
      else if (w === "case" && depth) depth++;
      else if (w === "end" && depth) depth--;
      i += w.length;
      continue;
    }
    if (c === ";" && !depth) {
      out.push(sql.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  if (sql.slice(start).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|\s/g, "")) out.push(sql.slice(start));
  return out.filter((s) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|\s|;/g, ""));
}

// supabase/cli pkg/migration/file.go (v2.118.0): these run outside the per-file batch.
const INCOMPATIBLE = [
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY(\s|$)/,
  /^DROP\s+INDEX\s+CONCURRENTLY(\s|$)/,
  /^REINDEX(\s|\().*\sCONCURRENTLY(\s|$)/s,
  /^VACUUM(\s|\(|$)/,
  /^ALTER\s+SYSTEM(\s|$)/,
  /^CLUSTER(\s|$)/,
];
const lead = (s) => s.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "").toUpperCase();
export const pipelineIncompatible = (s) => INCOMPATIBLE.some((r) => r.test(lead(s)));

/** Apply one migration file like `supabase db push`: one implicit transaction per batch. */
export async function applyLikeSupabase(db, sql) {
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await db.exec("begin");
    try {
      for (const s of batch) await db.exec(s);
      await db.exec("commit");
    } catch (e) {
      await db.exec("rollback").catch(() => {});
      throw e;
    }
    batch = [];
  };
  for (const s of splitSql(sql)) {
    if (pipelineIncompatible(s)) {
      await flush();
      await db.exec(s);
    } else batch.push(s);
  }
  await flush();
}
