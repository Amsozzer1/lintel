# Lintel playground

A static page: paste Supabase migration SQL and seed rows, see what Lintel would flag. Postgres runs in the browser as [PGlite](https://pglite.dev) inside a Web Worker. No backend, nothing sent anywhere: the build sets a Content-Security-Policy that only allows this site's own files.

```sh
pnpm install                      # from the repo root
pnpm --filter @lintel/playground dev
pnpm playground:build             # static site in playground/dist
pnpm test:playground              # the engine and the CLI-identical output, under Node
```

## What runs

Nothing here decides what a finding is:

- **Environment:** `src/core/supabase/environment.ts`. These are the image's roles, schemas and grants, with `auth` and `storage` as Supabase Auth and Storage migrate them.
- **Extension stubs:** generated from the image (`extensions.generated.ts`).
- **Apply rules:** `src/core/supabase/apply.ts`.
- **Probe:** P001 (`src/core/probes/p001.ts`).
- **Linter SQL:** the 23 lints Supabase CLI v2.118.0 runs (`src/lints.generated.ts`, `pnpm --filter @lintel/playground gen:lints`).

`src/engine.ts` wires those to PGlite. `test/render.test.ts` checks that the page prints exactly what `lintel check` prints for the same report.

## Deploying to amsozzer.com/lintel/

`pnpm playground:build` writes a site meant to be served under `/lintel/`. Use `PLAYGROUND_BASE=/other/ pnpm playground:build` for a different path.

```
playground/dist/
  _headers       Cloudflare headers, scoped to /lintel/
  lintel/        the site: index.html, assets/, pglite/0.5.8/, licenses/
```

If amsozzer.com is a Cloudflare Pages project, or a Worker with static assets, built from a folder of files:

1. Copy `playground/dist/lintel/` into the site's output directory as `lintel/`.
2. Append `playground/dist/_headers` to the site's `_headers` file at the output root, or add that file if there isn't one. All its rules start with `/lintel/`, so nothing else on the site changes.

No route, DNS or Worker change is needed.

What `_headers` sets:

- **Content-Security-Policy:** only this origin may be fetched from. The page carries the same policy as a meta tag; the header also forbids framing.
- **Immutable caching:**
  - `/lintel/assets/*`, whose names are content-hashed;
  - `/lintel/pglite/*`, which lives under PGlite's version, so an upgrade is a new path.
- **`index.html`** keeps Cloudflare's default (`max-age=0, must-revalidate`), so deploys show up at once.

The site is about 19 MB in 61 files, about 5 MB compressed over the wire. The largest file is `pglite/0.5.8/pglite.wasm` at 10 MB, under the 25 MiB per-file limit. Extension bundles are published as `.bundle` rather than `.tar.gz`, so no server adds `Content-Encoding: gzip` to them.

## Fonts

- **Charter** (Bitstream, 1987): permissive Bitstream license, via Matthew Butterick's Charter 210112 package.
- **Commit Mono** v1.143: SIL Open Font License 1.1.

Both are Latin subsets, converted to WOFF2 with fontTools. License texts and every other third-party notice are in `public/licenses/`.

`spike/` is the feasibility harness from before the build. It is kept for the record and the build doesn't use it (see `FEASIBILITY.md`).
