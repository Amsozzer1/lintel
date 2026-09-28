# Lintel design

Status: **in progress**. The README's status table says what exists today. Everything else here is intended behavior.

## 1. Problem

In Postgres, row-level security is **off** by default when a table is created. On Supabase, the `public` schema is served over HTTP by PostgREST, and the `anon` key that calls it ships in every frontend. One migration that forgets `enable row level security`, or adds `using (true)` to "make it work", can expose every row to anyone.

The moment to catch that is the pull request that introduces it: before merge, as a diff, with proof.

## 2. Build on Supabase's linter, don't rebuild it

Supabase already ships an excellent linter, **splinter**. It is exposed through:
- the dashboard's Security and Performance Advisors;
- `supabase db advisors` in the CLI, with JSON output and a stable `cache_key` per finding;
- the Supabase MCP server's `get_advisors`.

Lintel uses it for all static findings (about 30 lints) instead of re-implementing them. It adds what those tools don't do:

| Layer | What it is | Source |
|---|---|---|
| Static findings | RLS disabled, always-true policies, mutable `search_path`, unindexed FKs, … | `supabase db advisors`, normalized |
| **Proof** | Probes that query as `anon` or as another user and report what actually leaks | Lintel |
| **PR engine** | Replays base and head migrations into two throwaway databases, diffs, posts one sticky comment | Lintel |
| **Surfaces** | One operation registry served as a CLI, an MCP server and a REST API | Lintel |

## 3. Architecture

```
src/core ─ findings model (zod) · diff · redaction · errors · operation registry
  ├─ sources/advisors   runs `supabase db advisors`, pins its output flags, normalizes
  ├─ probes/            P001 anon read · P002 anon write · P003 cross-user read
  └─ replay/            throwaway containers · git-ref extraction · apply as `postgres`
src/cli   src/mcp   src/api     ← surfaces; core never imports them (enforced in CI)
```

- One npm package. dependency-cruiser enforces the layering and fails if it analyzes zero modules.
- Subcommands load lazily: `lintel --help` starts in about 25 ms.

## 4. Replaying migrations (the PR engine)

`checkMigrations({ baseRef, headRef })` is the one function behind:
- the GitHub Action;
- `lintel migrations check`;
- the MCP tool `check_migrations`.

It works in four steps:

1. Read `supabase/migrations/*.sql` and `supabase/seed.sql` at the base ref and at the head (a ref or the working tree).
2. Start **two fresh containers** from the digest-pinned `supabase/postgres` image. It is the same image `supabase start` uses, so roles, `auth` and the default grants match.
3. Apply each side's full migration set, then the seed, **as `postgres`** (the role `supabase db push` uses). Objects created by any other role would miss Supabase's default grants, and exposure checks would silently pass.
4. Check both, then diff by fingerprint.

Design decisions:

- **Why two databases, not one replayed twice:** PRs edit old migrations and land out of timestamp order. Two full replays handle both.
- **Readiness:** the image's init scripts restart the server. "Ready" means the `authenticated` role exists and the postmaster start time is stable.
- **Why statistics-based lints are dropped in replay** (`unused_index`, `table_bloat`): on a fresh database they would fire on every new index.
- **The `auth.jwt()` stub:** the image predates it, so Lintel creates it when missing.
- **Cleanup:** containers are labelled `lintel.managed=1`, removed on exit and on Ctrl-C, and `lintel doctor --cleanup` removes leftovers.

## 5. Findings and diffs

Findings follow the JSON Schemas `schemas/findings.v1.json` and `schemas/diff.v1.json`. They are generated from the zod source and drift-tested.

- **Fingerprint:**
  - Advisors: `advisor:<cache_key>`.
  - Probes: a JSON tuple of raw identifiers, so quoted names containing dots can't collide.
  - Never OIDs, because base and head are different databases. A rename shows as one resolved plus one new.
- **Diff:** `new` (head only), `resolved` (base only), `unchanged`. Only `new` findings at or above `--fail-on` fail.

## 6. Probes

Probes are native and run per exposed table and view.

| ID | Proves | Where it may run |
|---|---|---|
| P001 | As `anon`, rows are visible (`exists`) | any database (read-only) |
| P002 | As `anon`, `update`/`delete` affects rows (savepoint, rolled back) | Lintel-managed containers only |
| P003 | As user A, rows owned by user B are visible (owner = FK to `auth.users(id)`) | any database (read-only) |

Safety:

- Each probe runs in `begin … rollback` with `set local role`, local JWT claims, and `statement_timeout` / `lock_timeout`.
- An empty table gives the state `unverified_no_rows`, never a silent pass.
- Write probes are limited to containers Lintel started. Triggers using `dblink` or other out-of-transaction effects can escape a rollback, so the only safe target is a disposable one.

## 7. The PR comment and fork safety

**Workflow 1** (`pull_request`, read-only token, no secrets):
- builds lintel **from the base commit**, so a PR can't modify the tool that judges it;
- runs `lintel ci` against the merge commit;
- uploads the reports as an artifact.

**Workflow 2** (`workflow_run`, `pull-requests: write`):
- never checks out PR code;
- confirms the artifact belongs to the PR's current head SHA;
- renders markdown with trusted code, and creates or updates **one** comment.

`pull_request_target` is never used.

The comment:
- escapes every identifier: HTML, table pipes, `@mentions`, `#refs` and autolinks;
- stays under GitHub's size limit;
- carries a hidden state marker, which is how it reports "**fixed in this PR**";
- lists suppressions added by the PR, so reviewers see them.

## 8. CLI

```
lintel check              [--db <url|env:VAR>] [--format human|json] [--fail-on …]
lintel migrations check   [--base-ref main] [--head-ref <ref>]   # your working tree vs a branch
lintel ci                 --base-ref <ref> --head-ref <ref> [--out-dir] [--format markdown|json|human]
lintel diff               <base.json> <head.json>
lintel setup | doctor [--cleanup] | explain <rule> | mcp | serve
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Findings (for `ci` and `diff`: *new* findings) at or above `--fail-on` |
| 2 | Usage |
| 3 | Can't connect: database, Docker or the Supabase CLI |
| 4 | Internal bug |
| 5 | A migration failed to apply |

**Errors:** every error has a stable code, a likely cause, the next command to try, and a docs link. The same codes are used by the CLI, the REST envelope and MCP tool errors.

**Secrets:**
- Passwords are redacted at every output sink, fuzz-tested with passwords containing unencoded `@ # / % ?`.
- They reach child processes through the environment, never argv.
- `--db env:VAR` keeps them out of shell history.

## 9. MCP and REST

- **MCP** (`lintel mcp --config <abs path>`):
  - tools `check_migrations`, `run_checks`, `diff`, `list_checks` and `explain`, all read-only and taking profile names, not URLs;
  - identifiers in results are marked as untrusted data;
  - only JSON-RPC goes to stdout; everything else goes to stderr.
- **REST** (`lintel serve`):
  - fast operations only, under `/v1`, with an OpenAPI 3.1 spec generated from the same registry;
  - binds to 127.0.0.1 and rejects foreign `Host` and `Origin` headers (DNS rebinding);
  - requires a startup token;
  - long-running replays belong behind an async `POST /v1/runs` → `202`, which is listed as next.

## 10. Testing

| Layer | How |
|---|---|
| Unit | Diff, redaction (fast-check), markdown injection and size limits, advisor output parsing (all known shapes), error mapping |
| Integration | Real containers: default grants, auth functions, leak detected, fix detected, broken migration, bad ref, wrong password redacted |
| Contracts | JSON Schemas regenerated and compared; `tools/list` snapshot; OpenAPI drift |
| CLI | Built binary: exit codes, output snapshots, secrets never printed |
| Action | Dogfooded on a permanent demo PR in this repo |

## 11. Non-goals (for now)

- No autofix: Lintel shows fixes and never runs them.
- No hosted service.
- GitHub is the only CI provider.
- Native static checks beyond what splinter covers.
