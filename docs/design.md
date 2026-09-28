# Lintel design

Status: **draft spec, pre-implementation.** Everything here describes intended behavior. The README's status table says what actually exists.

## 1. Problem

In Postgres, tables start with row-level security **off**. On Supabase, the `public` schema is exposed over HTTP by PostgREST, and the `anon` key that calls it ships in every frontend. So one migration that creates a table and forgets `ENABLE ROW LEVEL SECURITY`, or adds `USING (true)` to "make it work", can expose every row to anyone on the internet.

The moment to catch that is the pull request that introduces it: before merge, next to the code, as a diff.

## 2. Prior art (and why Lintel still exists)

Credit where due. These exist and are good:

- **splinter**, Supabase's open-source SQL linter. It powers the dashboard's Security and Performance Advisors and covers every catalog check in §5.
- **`supabase db advisors`** in the Supabase CLI runs those lints against a local, linked or URL database, with `--fail-on`.
- The **Supabase MCP server** exposes `get_advisors` to agents.
- **squawk** statically lints migration files for unsafe DDL. **plpgsql_check** (`supabase db lint`) checks function bodies.

What Lintel adds:

1. **Diff, not report.** It compares findings on the PR branch against the base branch and posts one sticky PR comment with **new / fixed / unchanged**. Only *new* findings fail the check.
2. **Proof, not suspicion.** Optional **probes** run real queries as `anon` or as a synthetic authenticated user inside a rolled-back transaction on a disposable database, and report what actually leaks: *"anon can read 14 rows from public.messages"*.
3. **Adoption on messy databases.** Baseline files and suppressions that require a written reason.
4. **One contract, three surfaces.** A single operation registry drives the CLI, a versioned REST API (OpenAPI 3.1) and an MCP server. CI fails on breaking changes to any of them.

Lintel does not replace any of the above. Native checks are cross-checked against splinter in CI, and disagreements are documented in `docs/checks.md`.

## 3. Architecture

```
             ┌──────────────────────── src/core ────────────────────────┐
             │ checks/*  probes/*  runner  fingerprint  diff  baseline │
             │ findings model (zod) ── operation registry ─────────────┐│
             └─────────────────────────────────────────────────────────┘│
                  ▲                     ▲                     ▲          │
            src/cli (commander)   src/api (Hono)        src/mcp (SDK)    │
            exit codes, TTY       HTTP status,          tool results,    │
            output, --json        OpenAPI 3.1           tool schemas  ◄──┘
```

- **One npm package**, internal layers enforced by dependency-cruiser: `core` imports none of `cli`, `api` or `mcp`.
- **Operation registry:** each operation (`listChecks`, `runChecks`, `diff`, `explainCheck`) is declared once as `{ id, input: zod, output: zod, handler }`. REST routes, OpenAPI and MCP tools are generated from it, and CLI `--json` output is validated against the same schemas.
- Subcommands are lazily imported so `lintel --help` never loads Hono, the MCP SDK or `pg`.

## 4. Findings model

```jsonc
{
  "schema": "lintel.findings/v1",
  "lintel_version": "0.1.0",
  "target": { "database": "postgres://user:***@host:5432/db", "schemas": ["public"] },
  "findings": [
    {
      "fingerprint": "L001:public.messages",
      "check": "L001", "name": "rls_disabled_exposed", "level": "error",
      "object": { "schema": "public", "name": "messages", "kind": "table" },
      "message": "RLS is disabled on public.messages, and anon can SELECT, INSERT, UPDATE, DELETE.",
      "fix_sql": "alter table public.messages enable row level security;",
      "docs_url": "https://github.com/Amsozzer1/lintel/blob/main/docs/checks.md#l001",
      "suppressed": null
    }
  ]
}
```

- **Fingerprint** = `check + schema + object (+ sub-object, e.g. policy name)`. It never uses OIDs, because base and head are different databases. A rename therefore shows as one fixed plus one new finding. That is intentional and documented.
- The JSON Schema is published at `schemas/findings.v1.json`. Breaking changes mean `v2`.

## 5. Checks (v1)

"Exposed" means: in a schema listed via `--schema` (default `public`), **and** `anon` or `authenticated` holds a relevant privilege.

| ID | Name | Level | Fires when |
|---|---|---|---|
| L001 | `rls_disabled_exposed` | error | Exposed table/partition with RLS off |
| L002 | `rls_enabled_no_policy` | info | RLS on, zero policies (deny-all; often intentional) |
| L003 | `policy_always_true` | error (write) / warn (select) | PERMISSIVE policy for `public`/`anon`/`authenticated` whose `USING`/`WITH CHECK` normalizes to true |
| L004 | `security_definer_executable` | error (anon) / warn | `SECURITY DEFINER` function in exposed schema, EXECUTE held by anon/authenticated/PUBLIC, no pinned `search_path` |
| L005 | `fk_unindexed` | warn | No index whose leading columns are exactly the FK column set |
| L006 | `duplicate_index` | warn | Same `indkey, indclass, indcollation, indoption, indexprs, indpred` on one table |
| L007 | `no_primary_key` | info | Exposed table without a primary key |
| L008 | `auth_call_per_row` | warn | Policy calls `auth.uid()` / `auth.jwt()` / `current_setting()` without wrapping it in a subselect (re-evaluated per row) |

**Probes** run only with `--probe`, and only against targets marked disposable:

| ID | Name | Proves |
|---|---|---|
| P001 | `anon_can_read` | As `anon`, `SELECT` returns ≥ 1 row |
| P002 | `anon_can_write` | As `anon`, `UPDATE`/`DELETE` affects ≥ 1 row (in a savepoint, rolled back) |
| P003 | `cross_user_read` | As synthetic user A, rows owned by user B are visible (owner = column with FK to `auth.users(id)`) |

Probe safety:

- Every probe runs in `BEGIN … ROLLBACK` with `SET LOCAL ROLE` and `SET LOCAL request.jwt.claims`.
- Tests assert table checksums are identical before and after.
- The docs warn that triggers using `dblink` or other out-of-transaction side effects can escape a rollback, which is why probes refuse non-disposable targets.

Every check ships a message, exact fix SQL, a docs anchor, known false positives, and its splinter equivalent.

## 6. CLI

```
lintel check    [--db <url> | --profile <name>] [--schema public,api] [--probe]
                [--format human|json|markdown] [--fail-on error|warn|info|none]
                [--baseline lintel-baseline.json] [--write-baseline]
lintel diff     <base.json> <head.json> [--format human|json|markdown] [--fail-on …]
lintel diff     --base-db <url> --head-db <url> …          # convenience wrapper
lintel explain  <check-id>
lintel serve    [--port 7070]                               # binds 127.0.0.1 only
lintel mcp                                                  # stdio
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Findings ≥ `--fail-on`. For `diff`, **new** findings only |
| 2 | Usage error |
| 3 | Cannot connect / authenticate |
| 4 | Internal error (prints an issue link) |

**Errors:** every error has a stable code, what happened, the likely cause, the next command to try, and a docs link. Example:

```
error LINTEL_E_CONNECT_REFUSED: could not connect to localhost:54322
  likely cause: the local Supabase stack isn't running
  try: supabase status   (or: supabase start)
  docs: …/docs/errors.md#lintel_e_connect_refused
```

**Redaction:** passwords never appear in any output, error or JSON. This covers URL userinfo, `?password=`, percent-encoded values, libpq `key=value` strings and `PGPASSWORD`. It is fuzz-tested.

**Config:** `lintel.config.json`, validated, with a published JSON Schema:

```json
{
  "schemas": ["public"],
  "failOn": "error",
  "profiles": { "local": { "url": "env:DATABASE_URL", "disposable": true } },
  "ignore": [{ "check": "L003", "object": "public.blog_posts", "reason": "Posts are public by design" }]
}
```

Output behavior:

- Human output groups by level, then object, and ends with one summary line.
- Honors `NO_COLOR`.
- When stdout isn't a TTY, output is plain.

## 7. REST API (`lintel serve`)

- `GET /v1/checks`
- `POST /v1/checks/run`
- `POST /v1/diff`
- `GET /v1/openapi.json`

Rules:

- The request body references a **profile name**, never a connection string. Credentials stay server-side, in local config.
- Binds to `127.0.0.1` in v1. Hosting is out of scope.
- Error envelope: `{ "error": { "code", "message", "hint", "docs_url" } }`, with the same codes as the CLI.
- Validation with zod.
- CI runs **oasdiff** against the last released spec and fails on breaking changes.

## 8. MCP server (`lintel mcp`)

Tools: `list_checks`, `run_checks`, `diff`, `explain_check`. They are generated from the operation registry and snapshot-tested (`tools/list`).

- **Read-only:** tools return fix SQL and never execute it.
- **No credentials in the model's context:** tools take profile names.
- **Untrusted data:** object names and comments come from the database and are returned as quoted data fields. Tool descriptions tell the agent to treat them as data, not instructions.
- Probes are available only for profiles marked `disposable`.

## 9. GitHub Action

A composite action runs the published CLI at a pinned version. In CI it works like this:

1. Start one ephemeral `supabase/postgres` service container.
2. Apply the base branch's migrations → `lintel check --format json > base.json`.
3. Apply the PR's new migrations on top → `head.json`. If the PR modifies an existing migration file, warn.
4. Run `lintel diff base.json head.json --format markdown`.

**Fork safety:** job 1 runs on `pull_request` with no secrets and uploads the findings as an artifact. Job 2 runs on `workflow_run` with `pull-requests: write`, reads only that artifact, and creates or updates **one** sticky comment. PR code never runs with a write token. `pull_request_target` is not used.

Production path (documented, not required): run against Supabase Branching preview databases.

## 10. Testing

| Layer | How |
|---|---|
| Unit | fingerprint, diff, baseline, suppressions, formatters; fast-check fuzzing of redaction |
| Checks | Testcontainers `supabase/postgres`. Each check fires on the planted case and stays silent on the fixed case, on non-exposed schemas and when suppressed |
| Probes | Leak proven on planted data; checksums identical before/after |
| splinter cross-check | splinter SQL fetched at a pinned commit in CI; mapping asserted, differences documented |
| CLI e2e | Built binary, every exit code, human + JSON snapshots, `NO_COLOR`, non-TTY |
| Contracts | JSON Schema validation; OpenAPI validity; oasdiff vs last tag; MCP `tools/list` snapshot |
| MCP | In-process client calls every tool, including error paths |
| Perf | hyperfine: `lintel --help` < 300 ms, `check` on demo DB < 1 s |
| Action | Dogfooded on a permanent demo PR in this repo |

## 11. Engineering standards

- Node 22 and 24 (CI matrix). TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- tsup bundle, Biome, dependency-cruiser, Vitest.
- Semver across all contracts: `lintel.findings/v1`, `/v1`, and MCP tool names/schemas.
- Actions pinned by SHA, least-privilege `permissions:` per job.
- Releases are tagged manually and published with `npm publish --provenance`.
- `SECURITY.md` covers the threat model: untrusted migration SQL, credentials, prompt injection via object names.

## 12. Milestones

| # | Milestone | Acceptance |
|---|---|---|
| M0 | Scaffold, CI on Node 22/24 with Postgres service | CI green |
| M1 | Findings model + schema, runner, demo schema, L001 L003 L004 | Planted fires; fixed/non-exposed silent |
| M2 | L002 L005–L008, fingerprints, diff, baseline, suppressions | Exact new/fixed sets in diff tests |
| M3 | CLI: commands, formats, exit codes, errors, redaction, cold start | Snapshots; no password in any output; < 300 ms |
| M4 | GitHub Action + demo PR | Comment appears, flips to "2 fixed, 0 new", check green |
| M5 | Probes P001–P003 | Leaks proven; DB unchanged |
| M6 | Registry → REST/OpenAPI + MCP; contract gates | Breaking change fails CI; MCP client calls `diff` |
| M7 | Docs, splinter cross-check, README GIFs (VHS) | A stranger installs and runs in < 2 minutes |

## 13. Non-goals and known limits (v1)

- No autofix. Lintel prints fix SQL and never executes it.
- It can't see PostgREST's `db_schemas` config, so exposed schemas come from `--schema`.
- Static checks can't judge intent. That's what suppressions with reasons are for.
- Probes need seeded data and a disposable database.
- Only the GitHub Action is provided for CI.
- There is no hosted service.

## 14. Next

- Autofix PRs.
- Run automatically against Supabase Branching previews via the Management API.
- Custom checks from config.
- SARIF output for code scanning.
- Streamable HTTP MCP transport.
- Generic OpenAPI → MCP tool generation.
