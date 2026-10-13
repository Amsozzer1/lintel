/**
 * The engine runs here, off the page's thread, so a migration that loops forever can be stopped
 * by terminating this worker: PGlite can't cancel a query (statement_timeout does nothing).
 */
import { Engine } from "./engine.ts";
import type { ToPage, ToWorker } from "./protocol.ts";

/** The part of the worker's global scope used here (the DOM and WebWorker typings can't share a program). */
declare const self: {
  postMessage(message: ToPage): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
};

/** Downloaded up front, with progress: the engine plus the extensions the Supabase base needs. */
const PRELOAD = [
  "pglite.wasm",
  "initdb.wasm",
  "pglite.data",
  "pgcrypto.bundle",
  "uuid-ossp.bundle",
  "pg_stat_statements.bundle",
];

const post = (m: ToPage) => self.postMessage(m);
let ready: Promise<Engine> | undefined;

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === "boot") {
    ready ??= boot(m.base);
    ready.catch((e: unknown) => post({ type: "failed", message: String(e) }));
    return;
  }
  if (!ready) return;
  const engine = await ready;
  post({ type: "started", id: m.id });
  post({ type: "result", id: m.id, outcome: await engine.run(m.migration, m.seed) });
};

async function boot(base: string): Promise<Engine> {
  const started = performance.now();
  const total = PRELOAD.reduce((n, f) => n + (__PGLITE_SIZES__[f] ?? 0), 0);
  let loaded = 0;
  let lastPost = 0;
  const bytes = new Map<string, ArrayBuffer>();
  await Promise.all(
    PRELOAD.map(async (file) => {
      const res = await fetch(new URL(`pglite/${file}`, base));
      if (!res.ok || !res.body) throw new Error(`could not load ${file}: HTTP ${res.status}`);
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        loaded += value.byteLength;
        if (performance.now() - lastPost > 80) {
          lastPost = performance.now();
          post({ type: "progress", loaded, total });
        }
      }
      bytes.set(file, await gzipped(file, new Blob(chunks)));
    }),
  );
  post({ type: "progress", loaded: total, total });
  post({ type: "starting" });
  // Extension bundles we already hold go to PGlite as blob URLs, so nothing downloads twice.
  const blobs = new Map(
    [...bytes]
      .filter(([f]) => f.endsWith(".bundle"))
      .map(([f, b]) => [f, URL.createObjectURL(new Blob([b]))]),
  );
  const engine = new Engine({
    native: __PGLITE_NATIVE__,
    url: (file) => {
      const bundle = file.replace(/\.tar\.gz$/, ".bundle");
      return new URL(blobs.get(bundle) ?? new URL(`pglite/${bundle}`, base).href);
    },
    load: async (file) => {
      const b = bytes.get(file);
      if (!b) throw new Error(`${file} was not preloaded`);
      return b;
    },
  });
  await engine.warmUp();
  post({ type: "ready", ms: Math.round(performance.now() - started) });
  return engine;
}

/**
 * PGlite gunzips a bundle unless the response says it was already decoded, and a blob URL says
 * nothing. If a server decoded the download on the way (Content-Encoding: gzip), gzip it again.
 */
async function gzipped(file: string, blob: Blob): Promise<ArrayBuffer> {
  const buf = await blob.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (!file.endsWith(".bundle") || (head[0] === 0x1f && head[1] === 0x8b)) return buf;
  return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
