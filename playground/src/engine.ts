/**
 * Lintel's checks against PGlite: the CLI's Supabase environment, apply rules, linter SQL and
 * P001 probe, from src/core, on Postgres compiled to WebAssembly. Runs in a Web Worker, and in
 * Node for tests. Nothing here decides what a finding is; it only wires an engine to the core.
 */
import { type Extension, PGlite } from "@electric-sql/pglite";
import { type LintelError, toLintelError } from "../../src/core/errors.ts";
import { REPORT_SCHEMA, type Report, sortFindings } from "../../src/core/findings.ts";
import { probeAnonRead } from "../../src/core/probes/p001.ts";
import { normalizeLint, REPLAY_DENYLIST, toAdvisorLint } from "../../src/core/sources/lints.ts";
import { applyMigration, applySeed } from "../../src/core/supabase/apply.ts";
import {
  extensionStubFiles,
  standaloneBeforeChecksSql,
  standaloneSessionReset,
  standaloneSetupSql,
  unavailableExtension,
} from "../../src/core/supabase/environment.ts";
import {
  EXTENSION_STUBS,
  IMAGE_EXTENSIONS,
  SUPAUTILS_EXTENSION_OVERRIDES,
  UNSTUBBABLE_EXTENSIONS,
} from "../../src/core/supabase/extensions.generated.ts";
import { LINTEL_VERSION } from "../../src/core/version.ts";
import { LINTS_SQL } from "./lints.generated.ts";

export const LABEL = "playground";

/** Where the engine's files come from: PGlite's wasm, data and extension bundles. */
export interface Assets {
  /** Extensions PGlite can create for real (each has a `<name>.tar.gz` bundle). */
  native: readonly string[];
  /** URL of a bundled file, e.g. `pgcrypto.tar.gz`. */
  url(file: string): URL;
  /** Bytes of pglite.wasm, initdb.wasm or pglite.data. */
  load(file: "pglite.wasm" | "initdb.wasm" | "pglite.data"): Promise<ArrayBuffer>;
}

export type ErrorJson = ReturnType<LintelError["toJSON"]> & { cause?: string };

export type Outcome =
  | { ok: true; report: Report; ms: number }
  | { ok: false; error: ErrorJson; ms: number };

const CREATE_EXTENSION = /create\s+extension\s+(?:if\s+not\s+exists\s+)?("?)([\w-]+)\1/gi;

export class Engine {
  private readonly assets: Assets;
  private readonly native: Set<string>;
  private modules?: Promise<{ pglite: WebAssembly.Module; initdb: WebAssembly.Module; data: Blob }>;
  /** Data directories with the environment applied, by the set of native extensions loaded. */
  private readonly templates = new Map<string, Promise<Blob>>();
  private stubFiles?: ReturnType<typeof extensionStubFiles>;

  constructor(assets: Assets) {
    this.assets = assets;
    this.native = new Set([...assets.native, "plpgsql"]);
  }

  /** Download and boot the base environment, so the first run doesn't wait for it. */
  async warmUp(): Promise<void> {
    await this.template(this.nativeNeeded(""));
  }

  async run(migration: string, seed: string): Promise<Outcome> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    let db: PGlite | undefined;
    try {
      const native = this.nativeNeeded(`${migration}\n${seed}`);
      // A fresh Postgres for every run, started from the prepared data directory.
      db = await this.start(native, await this.template(native));
      const exec = (sql: string) => (db as PGlite).exec(sql);
      await applyMigration(exec, { name: "migration.sql", sql: migration }, LABEL, {
        reset: standaloneSessionReset(),
      });
      if (seed.trim()) await applySeed(exec, { name: "seed.sql", sql: seed }, LABEL);
      for (const sql of standaloneBeforeChecksSql(SUPAUTILS_EXTENSION_OVERRIDES)) await exec(sql);
      return { ok: true, report: await check(db), ms: ms() };
    } catch (err) {
      return { ok: false, error: this.describe(toLintelError(err)), ms: ms() };
    } finally {
      await db?.close().catch(() => {});
    }
  }

  /** Native extensions the environment plus this SQL create, with what stubs require. */
  private nativeNeeded(sql: string): string[] {
    const needed = new Set<string>();
    const add = (name: string) => {
      if (needed.has(name)) return;
      if (this.native.has(name)) needed.add(name);
      for (const r of EXTENSION_STUBS[name]?.requires ?? []) add(r);
    };
    for (const text of [...standaloneSetupSql(), sql])
      for (const m of text.matchAll(CREATE_EXTENSION)) add((m[2] as string).toLowerCase());
    needed.delete("plpgsql");
    return [...needed].sort();
  }

  private template(native: string[]): Promise<Blob> {
    const key = native.join(",");
    let t = this.templates.get(key);
    if (!t) {
      t = this.boot(native);
      this.templates.set(key, t);
      t.catch(() => this.templates.delete(key));
    }
    return t;
  }

  /** Set up the Supabase environment once, and keep its data directory. */
  private async boot(native: string[]): Promise<Blob> {
    const db = await this.start(native);
    try {
      for (const sql of standaloneSetupSql()) await db.exec(sql);
      return await db.dumpDataDir("none");
    } finally {
      await db.close();
    }
  }

  /** A Postgres from the downloaded modules: never fetches anything itself. */
  private async start(native: string[], dataDir?: Blob): Promise<PGlite> {
    this.modules ??= Promise.all([
      this.assets.load("pglite.wasm").then((b) => WebAssembly.compile(b)),
      this.assets.load("initdb.wasm").then((b) => WebAssembly.compile(b)),
      this.assets.load("pglite.data").then((b) => new Blob([b])),
    ]).then(([pglite, initdb, data]) => ({ pglite, initdb, data }));
    const { pglite, initdb, data } = await this.modules;
    const extensions: Record<string, Extension> = Object.fromEntries(
      native.map((name) => [
        name,
        { name, setup: async () => ({ bundlePath: this.assets.url(`${name}.tar.gz`) }) },
      ]),
    );
    const db = await PGlite.create({
      pgliteWasmModule: pglite,
      initdbWasmModule: initdb,
      fsBundle: data,
      extensions,
      ...(dataDir ? { loadDataDir: dataDir } : {}),
    });
    this.installStubs(db);
    return db;
  }

  /** Extensions PGlite doesn't have become stubs generated from the Supabase image. */
  private installStubs(db: PGlite): void {
    const FS = (db as unknown as { Module: { FS: EmscriptenFS } }).Module.FS;
    const dir = "/pglite/share/postgresql/extension";
    this.stubFiles ??= extensionStubFiles(this.native, EXTENSION_STUBS);
    for (const f of this.stubFiles) {
      FS.writeFile(`${dir}/${f.name}.control`, f.control);
      FS.writeFile(`${dir}/${f.name}--stub.sql`, f.script);
    }
  }

  /** The core's error, with the playground's own reason when an extension can't run here. */
  private describe(e: LintelError): ErrorJson {
    const json: ErrorJson = { ...e.toJSON(), ...(e.likelyCause ? { cause: e.likelyCause } : {}) };
    const message = e.migration?.postgres.message ?? "";
    const name = /extension "([^"]+)" (?:is not available|does not exist)/.exec(message)?.[1];
    if (name && IMAGE_EXTENSIONS.includes(name)) {
      const why = unavailableExtension(name, this.native, EXTENSION_STUBS, UNSTUBBABLE_EXTENSIONS);
      if (why) {
        json.cause = `\`${name}\` is available on Supabase, but not in this playground: it ${why}.`;
        json.hint =
          "try: npx @amsozzer/lintel migrations check (replays into Supabase's real Postgres image)";
      }
    }
    return json;
  }
}

interface EmscriptenFS {
  writeFile(path: string, data: string): void;
}

/** What `runChecks` does after a replay: Supabase's linter, then P001, in one report. */
async function check(db: PGlite): Promise<Report> {
  const split = LINTS_SQL.indexOf(";\n\n");
  await db.exec("begin");
  let rows: Record<string, unknown>[];
  try {
    await db.exec(LINTS_SQL.slice(0, split));
    rows = (await db.query<Record<string, unknown>>(LINTS_SQL.slice(split + 3))).rows;
  } finally {
    await db.exec("rollback");
  }
  const advisorFindings = rows
    .map((r) => normalizeLint(toAdvisorLint(r)))
    .filter((f) => !REPLAY_DENYLIST.has(f.rule));
  const probes = await probeAnonRead(pgClient(db), ["public"]);
  return {
    schema: REPORT_SCHEMA,
    lintel_version: LINTEL_VERSION,
    target: { label: LABEL },
    probes: { ran: true, ...(probes.unverified.length ? { unverified: probes.unverified } : {}) },
    findings: sortFindings([...advisorFindings, ...probes.findings]),
  };
}

/** Just enough of pg.Client for the probe. PGlite's query() runs one statement. */
function pgClient(db: PGlite) {
  return {
    escapeIdentifier: (s: string) => `"${s.replaceAll('"', '""')}"`,
    async query(sql: string, params?: unknown[]) {
      if (params) return db.query(sql, params);
      return (await db.exec(sql)).at(-1) ?? { rows: [] };
    },
  } as unknown as Parameters<typeof probeAnonRead>[0];
}
