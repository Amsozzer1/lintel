# Playground feasibility: Lintel's checks in PGlite

Date: 2026-10-13. Question: can a static page run Lintel's static checks and the P001 proof on pasted Supabase migrations, entirely in the browser, with PGlite (Postgres compiled to WASM)?

**Answer: yes.** On every repo where both engines could replay the migrations, PGlite produced the same findings as the CLI, byte for byte. The work is in reproducing the Supabase environment, not in running Postgres.

## What was tested

- **Engine:** PGlite 0.5.8 (Postgres 17, like the pinned `supabase/postgres:17.6.1.013`) and `@electric-sql/pglite-pgvector` 0.0.9.
- **Environment:** a bootstrap mirroring the image:
  - roles: `anon`, `authenticated`, `service_role` (bypassrls), `authenticator`;
  - schemas and default grants copied from the image's `pg_default_acl`;
  - the image's `auth`/`storage` objects;
  - Lintel's `auth.jwt()` stub;
  - `search_path = "$user", public, extensions`.
- **Lints:** the exact SQL that `supabase db advisors` runs, extracted from Supabase CLI v2.118.0. There are 23 lints, run unchanged, the same way the CLI runs them (`begin; set local search_path = ''; … rollback`).
- **P001:** Lintel's own `src/core/probes/p001.ts`, imported unchanged behind a 10-line adapter (PGlite's `query()` takes one statement).
- **Corpus:** the demo, plus the migrations (and seed, when present) of 20 public open-source Supabase apps. They were picked from GitHub search results with more than 300 stars and at least 3 files in `supabase/migrations`, excluding forks, templates, SDKs and libraries.
- **Ground truth:** the real Lintel CLI (`lintel ci`, Docker) on the same 20 repos.

## Results

| | Lintel CLI today | PGlite + shims |
|---|---|---|
| Repos whose migrations and seed apply fully | **4 / 20** | **9 / 20** |
| Findings identical on repos both could replay (3 repos) | — | **50 / 50** |
| Demo with RLS removed from `messages` | 2 advisor errors + P001 | same, in Chrome |

- **Speed in Chrome, cold CDN:** PGlite ready in 2.5 s, environment in 2.8 s, demo applied and checked at 3.0 s.
  - **Lints:** about 50 ms.
  - **P001:** about 10 ms.
- **Findings across the 9 repos PGlite replays:** 220. These include `rls_policy_always_true` (23), `security_definer_view` (11) and P001 (2).

## What it takes

1. **Supabase's apply semantics.** `supabase db push` sends each file's statements as one implicit transaction. Only `CREATE/DROP INDEX CONCURRENTLY`, `REINDEX … CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM` and `CLUSTER` run on their own (`pkg/migration/file.go`). PGlite needs a statement splitter that understands quotes, dollar quotes and comments, plus that rule.
2. **Hosted `auth` and `storage` columns.** The bare image predates `storage.buckets.public`, `file_size_limit`, `objects.path_tokens`, `auth.identities` and `auth.users.email_confirmed_at`, which the Auth and Storage services add at runtime. Real migrations use them constantly.
3. **Extensions.**
   - PGlite ships most contrib modules, plus pgvector as a separate package. Load them only when the SQL creates them.
   - Supabase-only extensions (`pg_cron`, `pg_net`, `pg_graphql`, `supabase_vault`, `pgsodium`, `pgjwt`, `http`, `pg_jsonschema` …) can be registered as real extensions by writing stub control and script files into PGlite's virtual filesystem. `create extension pg_cron` then works without rewriting SQL.
   - Stubs define the functions and tables migrations call, and do nothing. That is irrelevant to RLS analysis.
4. **A watchdog.** `statement_timeout` does nothing in PGlite: `pg_sleep(3)` ran its full 3 s, and a CPU loop ran until it was killed. Run PGlite in a Web Worker, and terminate and recreate the worker on a wall-clock timeout.

## Limits to state in the UI

- **No base vs head:** it checks one state.
- **Approximate image:**
  - PGlite's `postgres` is a superuser, and the image's is not, so some statements that fail on Supabase will succeed here.
  - Stubbed extensions do nothing.
- **Can't run:** `pgroonga` indexes, PostGIS, `timescaledb`, and migrations that depend on tables created outside migrations.
- **P001 needs rows:** it proves leaks only for tables with rows from the seed box. Empty tables are reported as `unverified_no_rows`, as in the CLI.
- **A splinter gap:** `rls_policy_always_true` deliberately skips `for select … using (true)`, since public reads are often intended. A select-for-anon `using (true)` on an empty table therefore produces no finding unless rows are seeded.
- **Download size:** about 5.1 MB brotli-compressed (wasm 3.4 MB, data 1.7 MB), plus about 1.2 MB for `pgcrypto` when used.

## Findings about the CLI itself

The comparison surfaced these issues. Each affects `npx … migrations check` and the planned replay study.

1. **16 of 20 real repos fail to replay** (exit 5).
   - **9 failures (fixable):** the bare image's old `auth`/`storage` schema (item 2 above).
   - **4 failures (not fixable, should be reported clearly):** migrations that aren't self-contained.
2. **Apply semantics differ from Supabase:** psql autocommit per statement instead of one transaction per file. For example, a temp table created `on commit drop` disappears mid-file.
3. **Unrecognized file names:** Lintel applies every `*.sql`, while Supabase only applies `^[0-9]+_.*\.sql$`.
4. **Missing error text:** `--format json` (and, through the same `toJSON`, MCP errors) drops the Postgres error `details`. A failed replay says only "migration X failed to apply".

**Recommendation.** Put the Supabase environment (bootstrap SQL, hosted-schema shim, apply semantics, statement splitter) in `src/core` once. Have the CLI and the playground both use it, so they can't drift. Generate the hosted `auth`/`storage` shim from a dump of a `supabase start` stack with a script, rather than writing it by hand.

The spike harness (bootstrap, stubs, splitter) is in `playground/spike/`; it gets rebuilt properly with the playground. The 20-repo corpus is not committed.
