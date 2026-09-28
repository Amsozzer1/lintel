# Lintel

**Catch Supabase RLS leaks in the pull request that introduces them.**

Lintel replays your base branch's and your PR's migrations into two throwaway Supabase databases and checks both. It posts one PR comment listing only what the PR changed: **new**, **fixed in this PR**, **unchanged**. It can also *prove* a leak by querying as `anon` or as another user.

> **Status: early development.** The table below lists what works today. Everything else is in [docs/design.md](docs/design.md).

## Built on Supabase's linter

Supabase already ships an excellent linter, [splinter](https://github.com/supabase/splinter). You can reach it through the dashboard Advisors, `supabase db advisors` and the Supabase MCP server. Lintel **uses it** for every static finding, and adds three things it doesn't do:

1. **PR diffs.** Findings are compared against the base branch, so only what the PR introduces fails the check.
2. **Proof.** Probes run real queries as `anon` (and soon as another signed-in user) and report what actually leaks, e.g. *"the public anon key can read 2 rows from `public.messages` because RLS is disabled."*
3. **One contract, three surfaces:** a CLI, an MCP server for coding agents, and a REST API (in progress).

## Try it (from source)

You need Node 22 or later, Docker, and the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

```sh
git clone https://github.com/Amsozzer1/lintel && cd lintel
pnpm install && pnpm build
node dist/cli.js setup                      # one time: pulls the database image

cd ~/your-supabase-project
node ~/lintel/dist/cli.js migrations check  # your working tree vs main
```

```
New
  error public.messages rls_disabled_in_public
        Table `public.messages` is public, but RLS has not been enabled.
  error public.messages policy_exists_rls_disabled
        Table `public.messages` has RLS policies but RLS is not enabled on the table. …

2 new (2 error, 0 warn, 0 info) · 0 resolved · 0 unchanged
```

## Use it from a coding agent (MCP)

`lintel mcp` serves five read-only tools over stdio. The one agents need most is **`check_migrations`**. Ask your agent *"is this migration safe to merge?"* and it replays your base branch and your working tree into throwaway databases. It answers `NOT SAFE: the change introduces errors`, with the proven leak, before anything reaches a real database.

```json
{
  "mcpServers": {
    "lintel": {
      "command": "node",
      "args": ["/abs/path/to/lintel/dist/cli.js", "mcp", "--config", "/abs/path/to/lintel.config.json"],
      "env": { "STAGING_DATABASE_URL": "postgresql://…" }
    }
  }
}
```

```json
{ "schemas": ["public"], "profiles": { "staging": { "url": "env:STAGING_DATABASE_URL" } } }
```

Design choices:
- Tools take **profile names, never connection strings**, so credentials don't pass through the model's context.
- Every tool is read-only.
- Results mark database identifiers as untrusted data. A table can be named like an instruction.
- The tool list is a versioned contract ([`schemas/mcp-tools.v1.json`](schemas/mcp-tools.v1.json)) that CI checks for drift.

## Status

| Piece | State |
|---|---|
| `lintel check`: one database, static findings via Supabase advisors | ✅ |
| `lintel migrations check` / `lintel ci`: base vs head replay in throwaway databases, diff | ✅ |
| `lintel diff`, output as human / JSON / PR markdown, exit codes, password redaction | ✅ |
| GitHub Action with a fork-safe sticky comment ([see it on a demo PR](https://github.com/Amsozzer1/lintel/pull/1)) | ✅ |
| Probe P001: proves what the `anon` key can read (rolled back, read-only) | ✅ |
| Probes P002 anon write, P003 cross-user read | ⏳ |
| MCP server: `check_migrations`, `run_checks`, `diff_databases`, `list_checks`, `explain_check` | ✅ |
| REST API (OpenAPI 3.1) | ⏳ |

`lintel --help` starts in about 25 ms (measured on an M-series Mac with Node 24).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Findings at or above `--fail-on` (for `ci` / `diff`: **new** findings only) |
| 2 | Usage error |
| 3 | Can't reach the database, Docker or the Supabase CLI |
| 4 | Internal error |
| 5 | A migration failed to apply |

## License

MIT
