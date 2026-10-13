Third-party software in the Lintel playground

Charter (text face)               LICENSE-Charter.txt (Bitstream, permissive)
Commit Mono (SQL and findings)    LICENSE-CommitMono.txt (SIL Open Font License 1.1)
PGlite (Postgres in WebAssembly)  LICENSE-PGlite.txt (Apache-2.0)
pgvector for PGlite               LICENSE-pglite-pgvector.txt (Apache-2.0)
PostgreSQL                        COPYRIGHT-PostgreSQL.txt (PostgreSQL License)
Supabase CLI                      LICENSE-SupabaseCLI.txt (MIT)
Supabase Auth and Storage schemas, and the statement splitter used by Lintel's core:
                                  lintel-third-party-notices.md

The Supabase linter (splinter) SQL

The 23 lint queries are the ones Supabase CLI v2.118.0 runs for `supabase db advisors`:
  file    apps/cli/src/commands/db/advisors/advisors.lints-sql.ts
  repo    https://github.com/supabase/cli
  commit  70b42b8bf64b8cf1fd14c02c013d99dd655626e2 (tag v2.118.0; file last changed in 2a9063958e33)
  license MIT: apps/cli/package.json declares "license": "MIT", the published `supabase`
          npm package is MIT, and the license text is apps/cli-go/LICENSE
          (Copyright (c) 2021 Supabase, Inc. and contributors), copied to LICENSE-SupabaseCLI.txt.

They are not taken from github.com/supabase/splinter, which has no LICENSE file, or from
Supabase Studio's lint query (Apache-2.0), which now calls an API and whose last SQL version
(supabase/supabase@76d10d7, April 2024) has 13 of the 23 lints.
