# Lintel

**Catch Supabase RLS and index problems in the pull request that introduces them.** Lintel diffs findings against your base branch, posts one sticky PR comment with **new / fixed / unchanged**, and can *prove* a leak by querying as `anon` on a disposable database. The same engine is served as a CLI, a versioned REST API and an MCP server.

> **Status: design phase.** Nothing below is implemented yet. The full spec is in [docs/design.md](docs/design.md), and this README will only claim what the code does.

## How it relates to Supabase's own tooling

Supabase already ships an excellent linter ([splinter](https://github.com/supabase/splinter)), exposed through the dashboard Advisors, `supabase db advisors` and the Supabase MCP server. Lintel's native checks overlap with it deliberately and are cross-checked against it in CI. What Lintel adds:

1. **PR-time diff:** only *new* findings fail the check. Fixed ones are celebrated.
2. **Probes:** "anon can read 14 rows from `public.messages`", not "this policy looks permissive".
3. **Baselines and suppressions with reasons**, so it's adoptable on an existing database.

## Planned checks

| ID | Finds |
|---|---|
| L001 | RLS disabled on an exposed table |
| L002 | RLS enabled with no policies |
| L003 | Policy that is always true for `anon` / `authenticated` |
| L004 | Anon-executable `SECURITY DEFINER` function without a pinned `search_path` |
| L005 | Unindexed foreign key |
| L006 | Duplicate index |
| L007 | Exposed table without a primary key |
| L008 | `auth.uid()` evaluated per row in a policy |
| P001–P003 | Probes: anon read, anon write, cross-user read |

## Roadmap

| Milestone | Status |
|---|---|
| M0 Scaffold + CI | ☐ |
| M1–M2 Checks, fingerprints, diff, baseline | ☐ |
| M3 CLI | ☐ |
| M4 GitHub Action + demo PR | ☐ |
| M5 Probes | ☐ |
| M6 REST API (OpenAPI) + MCP server | ☐ |
| M7 Docs + splinter cross-check | ☐ |

## License

MIT
