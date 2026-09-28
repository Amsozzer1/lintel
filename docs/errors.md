# Errors

<!-- Generated from src/core/errors.ts by `pnpm gen`. Do not edit by hand. -->

Every Lintel error has a stable code. The CLI prints it with a hint and exits with the code below; the MCP server returns it as `{ error: { code, message, hint, docs_url } }` in a tool result with `isError: true`.

| Code | Exit | Meaning |
|---|---|---|
| [`LINTEL_E_USAGE`](#lintel_e_usage) | 2 | Invalid arguments or options. |
| [`LINTEL_E_NO_DATABASE`](#lintel_e_no_database) | 2 | No database was given. |
| [`LINTEL_E_INPUT_FILE`](#lintel_e_input_file) | 2 | An input file is missing or not a valid Lintel report. |
| [`LINTEL_E_CONNECT`](#lintel_e_connect) | 3 | Could not connect to the database. |
| [`LINTEL_E_AUTH`](#lintel_e_auth) | 3 | The database rejected the credentials. |
| [`LINTEL_E_SUPABASE_CLI`](#lintel_e_supabase_cli) | 3 | The Supabase CLI is missing or failed. |
| [`LINTEL_E_DOCKER`](#lintel_e_docker) | 3 | Docker is not available or a container failed to start. |
| [`LINTEL_E_GIT`](#lintel_e_git) | 2 | A git ref or path could not be read. |
| [`LINTEL_E_MIGRATION`](#lintel_e_migration) | 5 | A migration failed to apply. |
| [`LINTEL_E_INTERNAL`](#lintel_e_internal) | 4 | An unexpected error (a bug in Lintel). |

## LINTEL_E_USAGE

Invalid arguments or options. Exit code 2.

- Check the command and flags with `lintel <command> --help`.
- Unknown rule: rule ids are probe ids (`P001`) or Supabase lint names or numbers (`rls_disabled_in_public`, `0013`). The MCP tool `list_checks` lists them all.
- Unknown profile: add it under `profiles` in `lintel.config.json`.
- Config file not found from an MCP client: pass an absolute path with `lintel mcp --config /abs/path/lintel.config.json`. MCP clients start servers from an unpredictable directory.

## LINTEL_E_NO_DATABASE

No database was given. Exit code 2.

- Pass `--db <url>`, or set `DATABASE_URL`.
- For a profile that reads `env:NAME`, set that variable in the environment that starts Lintel. For MCP, that is the `env` block of the server's client config.

## LINTEL_E_INPUT_FILE

An input file is missing or not a valid Lintel report. Exit code 2.

- `lintel diff` takes two files written by `lintel check --format json`.
- Check the paths, and that both files are `lintel.findings/v1` reports ([schema](../schemas/findings.v1.json)).

## LINTEL_E_CONNECT

Could not connect to the database. Exit code 3.

- Local Supabase: is it running? Try `supabase status`, then `supabase start`.
- Check the host, port and database name in the connection string.
- Hosted Supabase: use the connection string from the dashboard (Connect → Session pooler if your network has no IPv6).

## LINTEL_E_AUTH

The database rejected the credentials. Exit code 3.

- Check the user and password in the connection string. Lintel never prints the password, so compare against your source.
- Special characters in the password must be URL-encoded (`@` → `%40`, `#` → `%23`).

## LINTEL_E_SUPABASE_CLI

The Supabase CLI is missing or failed. Exit code 3.

- Install it: `brew install supabase/tap/supabase` or `npm i -g supabase`, then check `supabase --version`.
- Run `lintel doctor` to see what Lintel finds on your PATH.
- If `supabase db advisors` timed out, the database may be overloaded or unreachable. Retry, or run it directly to see its own error.

## LINTEL_E_DOCKER

Docker is not available or a container failed to start. Exit code 3.

- Start Docker Desktop (or the Docker daemon) and check `docker info`.
- Image not downloaded: run `lintel setup` once. Lintel does not pull images in the middle of a check.
- Container not ready in time: the machine may be low on memory. Close other containers and retry.

## LINTEL_E_GIT

A git ref or path could not be read. Exit code 2.

- Folder does not exist or is not a git repository: pass the repository root (the folder that contains `.git`). From MCP, `repo_dir` must be an absolute path.
- Ref not found: fetch it with `git fetch origin main`. In GitHub Actions, use `actions/checkout` with `fetch-depth: 0`; checkouts are shallow by default.

## LINTEL_E_MIGRATION

A migration failed to apply. Exit code 5.

- The error names the migration and includes Postgres's message. Reproduce it with `supabase db reset`.
- A migration that depends on data or extensions from outside the repo will fail on a fresh database. Put what it needs in an earlier migration or `seed.sql`.

## LINTEL_E_INTERNAL

An unexpected error (a bug in Lintel). Exit code 4.

- Please [open an issue](https://github.com/Amsozzer1/lintel/issues) with the command you ran and the output.
