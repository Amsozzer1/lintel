import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Served at amsozzer.com/lintel/ unless PLAYGROUND_BASE says otherwise. */
const BASE = process.env.PLAYGROUND_BASE ?? "/lintel/";

/** PGlite's wasm, data and extension bundles, served from this site: no CDN, no third party. */
const require = createRequire(import.meta.url);
const pgliteDist = dirname(require.resolve("@electric-sql/pglite"));
const vectorDist = dirname(require.resolve("@electric-sql/pglite-pgvector"));
// Extension bundles are published as `<name>.bundle`: servers send `.tar.gz` with
// `Content-Encoding: gzip`, the browser then unpacks it, and PGlite's gunzip fails on the result.
const FILES: Record<string, string> = {
  ...Object.fromEntries(
    readdirSync(pgliteDist)
      .filter((f) => /\.(wasm|data|tar\.gz)$/.test(f))
      .map((f) => [f.replace(/\.tar\.gz$/, ".bundle"), join(pgliteDist, f)]),
  ),
  "vector.bundle": join(vectorDist, "vector.tar.gz"),
};
const NATIVE = Object.keys(FILES)
  .filter((f) => f.endsWith(".bundle"))
  .map((f) => f.replace(/\.bundle$/, ""));
const SIZES = Object.fromEntries(Object.entries(FILES).map(([f, p]) => [f, statSync(p).size]));
/** Under PGlite's version, so they can be cached forever: a new version is a new path. */
const PGLITE_VERSION = JSON.parse(readFileSync(join(pgliteDist, "..", "package.json"), "utf8"))
  .version as string;
const PGLITE_DIR = `pglite/${PGLITE_VERSION}/`;

function pgliteAssets(): Plugin {
  return {
    name: "lintel-pglite-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = /\/pglite\/[^/]+\/([^/?]+)/.exec(req.url ?? "")?.[1];
        const path = file ? FILES[decodeURIComponent(file)] : undefined;
        if (!path) return next();
        res.setHeader(
          "Content-Type",
          path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        );
        createReadStream(path).pipe(res);
      });
    },
    generateBundle() {
      for (const [file, path] of Object.entries(FILES))
        this.emitFile({
          type: "asset",
          fileName: `${PGLITE_DIR}${file}`,
          source: readFileSync(path),
        });
    },
  };
}

/**
 * PGlite's code also points at its wasm and data with `new URL(…, import.meta.url)`, so the
 * worker build emits a second copy. The engine hands PGlite the copies it already downloaded,
 * so these are never requested: drop them.
 */
function dropUnusedPgliteCopies(): Plugin {
  return {
    name: "lintel-drop-unused-pglite-copies",
    generateBundle(_options, bundle) {
      for (const key of Object.keys(bundle))
        if (/^assets\/(pglite|initdb)-[\w-]+\.(wasm|data)$/.test(key)) delete bundle[key];
    },
  };
}

/** License texts shipped with the bundle, copied from where they come from. */
function licenses(): Plugin {
  const files: Record<string, string> = {
    "licenses/LICENSE-PGlite.txt": join(pgliteDist, "..", "LICENSE"),
    "licenses/LICENSE-pglite-pgvector.txt": join(vectorDist, "..", "LICENSE"),
    "licenses/lintel-third-party-notices.md": new URL("../THIRD_PARTY_NOTICES.md", import.meta.url)
      .pathname,
  };
  return {
    name: "lintel-licenses",
    apply: "build",
    generateBundle() {
      for (const [fileName, path] of Object.entries(files))
        this.emitFile({ type: "asset", fileName, source: readFileSync(path) });
    },
  };
}

/** Only this site may be fetched from, so pasted SQL has nowhere else to go. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self' blob:",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "lintel-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}">`,
      ),
  };
}

/**
 * dist/_headers, for Cloudflare Pages or Workers static assets: the same CSP as a header (which can
 * also forbid framing), and immutable caching for hashed assets and versioned PGlite files.
 * It sits next to dist/lintel/, ready to copy into the site's output root.
 */
function cloudflareHeaders(): Plugin {
  return {
    name: "lintel-cloudflare-headers",
    apply: "build",
    closeBundle() {
      const immutable = "  Cache-Control: public, max-age=31536000, immutable";
      writeFileSync(
        new URL("dist/_headers", import.meta.url),
        [
          // `${BASE}*` doesn't match the page itself when the host drops the trailing slash.
          ...[BASE.replace(/\/$/, ""), `${BASE}*`].flatMap((path) => [
            path,
            `  Content-Security-Policy: ${CSP}; frame-ancestors 'none'`,
            "  X-Content-Type-Options: nosniff",
            "  Referrer-Policy: no-referrer",
            "",
          ]),
          `${BASE}assets/*`,
          immutable,
          "",
          `${BASE}pglite/*`,
          immutable,
          "",
        ].join("\n"),
      );
    },
  };
}

export default defineConfig({
  base: BASE,
  define: {
    __PGLITE_NATIVE__: JSON.stringify(NATIVE),
    __PGLITE_SIZES__: JSON.stringify(SIZES),
    __PGLITE_DIR__: JSON.stringify(PGLITE_DIR),
  },
  worker: { format: "es", plugins: () => [dropUnusedPgliteCopies()] },
  optimizeDeps: { exclude: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"] },
  build: { target: "es2022", outDir: `dist${BASE}`, emptyOutDir: true, assetsInlineLimit: 0 },
  plugins: [pgliteAssets(), licenses(), contentSecurityPolicy(), cloudflareHeaders()],
});
