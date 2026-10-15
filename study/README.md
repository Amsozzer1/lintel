# Replay study: how often do open-source Supabase apps ship a table the anon key can read?

Written 2026-10-13, before any repository was collected. Changes after data collection are listed under [Changes](#changes) with the reason.

## Question

Of public Supabase apps on GitHub, what share had a table exposed to the public `anon` key at some point in their migration history? How long did it stay exposed, in migration commits and in days?

## Ethics (non-negotiable)

- **Data:** only public GitHub repositories' migration and seed files.
- **Replay:** into throwaway local containers that Lintel manages.
  - The containers have **no outbound network access**. Migrations can call `pg_net`, `http` or `dblink`, often with a real project URL and key in the SQL. Each database sits on a Docker `--internal` network, and the host reaches it only through a forwarding container (`study/isolated-db.ts`). Isolation is checked before each run.
- **No live projects:** nothing connects to, queries or probes a live Supabase project or URL, and keys found in repositories are never used.
- **Anonymity:**
  - Published files carry no repository, owner or project names.
  - Repositories become `repo-NNN`. Table names become salted hashes, because a distinctive table name can be searched back to its repository.
  - Calendar dates are published only as days since the repository's first migration commit.
- **Private files:** the candidate list, raw results and the disclosure list stay in `study/private/`, which is git-ignored and never published.
- **Disclosure list:** a repository goes on the private list if its current HEAD still exposes a table and the project looks deployed. "Deployed" means a live URL in its README or repository homepage field; the URL is read, not visited. No issues are opened and nobody is contacted.

## Selection criteria

1. **Population:** public GitHub repositories with `.sql` files in a root-level `supabase/migrations/` directory, found with GitHub code search (`path:supabase/migrations extension:sql`). Results are sliced by file size to get past the search API's 1000-result cap. The raw candidate list is kept, privately.
2. **Eligible** repositories, as of collection time:
   1. are not forks, not archived and not marked as templates;
   2. have at least 3 files in `supabase/migrations/` named `<digits>_name.sql` (the files Supabase applies) at HEAD;
   3. have at least 2 commits that touch `supabase/migrations/`;
   4. are not owned by `supabase` or `supabase-community`, whose repositories are examples and SDK fixtures;
   5. don't have `template`, `starter`, `boilerplate`, `example`, `tutorial`, `course`, `workshop`, `sample` or `scaffold` as a word in the repository name or description.
3. **Pilot:** 10 repositories drawn uniformly at random (fixed seed) from the eligible list.
4. **Commits per repository:** every commit that touched `supabase/migrations/` or `supabase/seed.sql`, oldest first, capped at 30.
   - Above the cap, the first and last are kept, plus evenly spaced commits in between.
   - The pilot measures what the cap costs and how often it hides a short-lived exposure.

## Measurement

At each sampled commit, Lintel's existing pipeline replays that commit's migrations and `seed.sql`:

- **Environment:** the pinned `supabase/postgres` image, with the Auth and Storage schemas.
- **Apply rules:** the same as `supabase db push`.
- **Checks:** Supabase's linter via `supabase db advisors`, plus Lintel's P001 probe.

Recorded per commit:

- **Exposed relations:** what `anon` can select in the `public` schema, from `src/core/probes/exposure.ts`. Each one is classified:
  - **table without RLS:** the primary measure, "a table exposed to the anon key";
  - **view that bypasses RLS:** not `security_invoker`;
  - **materialized view:** these have no RLS.
- **All linter findings:** `rls_disabled_in_public`, `policy_exists_rls_disabled`, `rls_policy_always_true`, `security_definer_view` and the rest.
- **P001 results:** proven reads, or `unverified_no_rows`.
- **Replay failures:** when a commit's migrations don't apply (exit 5), the commit is excluded from timelines and the reason is kept.

**Exposure intervals.** For each relation, an exposure starts at the first sampled commit where it's exposed. It ends at the first later sampled commit where it isn't, split by how:

- **fixed:** the relation still exists, and RLS is on or the grant was revoked;
- **removed:** the relation was dropped.

An exposure still present at HEAD is censored. Durations are counted in migration commits and in days between commit dates. The median uses Kaplan–Meier, because censored exposures are still running.

**Headline numbers:**

- the share of eligible repositories with at least one exposed table at any sampled commit;
- the share still exposing one at HEAD;
- the median exposure duration.

Every number comes from an actual run. What can't be measured is reported as such, not estimated.

## Threats to validity

- **Migrations aren't the deployed state.** Tables created or changed in the dashboard never appear in migrations, so a repository can look exposed when it isn't, or the reverse. Replays that fail on objects created outside migrations are counted, not hidden.
- **Defaults have changed.** Newer Supabase projects enable RLS by default when tables are made in the dashboard. Migration-created tables don't get that.
- **Selection bias:**
  - Public repositories skew toward hobby, demo and portfolio projects, despite the keyword filter.
  - Code search only finds what it has indexed.
  - The root-level `supabase/` requirement drops monorepos.
- **Sampling:** the 30-commit cap can merge or miss short exposures between sampled commits.
- **Grants:** an exposure here means the `anon` role has `SELECT` in the replayed database. A project that revoked grants in the dashboard would differ.

## Files

| Path | What | Published |
|---|---|---|
| `study/README.md` | this method | yes |
| `study/*.ts` | collection, sampling and replay scripts | yes |
| `study/data/` | anonymised results (CSV, JSON) | yes |
| `study/results.md` | headline numbers, distributions, limitations | yes |
| `study/private/` | candidate list, raw per-repository results, disclosure list | **no** (git-ignored) |

## Changes

Made during the pilot (10 repositories, 2026-10-13). None of them changes which repositories are eligible.

1. **Candidate frame.** It is the union of eight code-search size slices (bytes):
   - 200..260, 500..560, 900..980, 1500..1600;
   - 2500..2650, 4000..4300, 7000..7600, 12000..14000.

   That is 8,000 search hits and 5,865 repositories. The full run adds slices; the same seed fixes the order.
2. **Fixed or removed.** Each commit also records every table and view in `public`. That is how an exposure that ends is classed as *fixed* (the relation is still there) or *removed* (it was dropped).
3. **Unit of the duration headline.** It is the repository: from the first commit where any table is exposed to the first later commit where none is. Per-table intervals are still published. Per table, a repository with 14 exposed tables would count 14 times.
4. **Failure class.** Exceptions raised by a migration itself (`P0001`, e.g. "table X must exist before this migration") get their own failure class instead of "other".
5. **Reading files.** The replay fetches each commit's migration files in one batched read before reading them. Hundreds of parallel lazy fetches from a blob-less clone failed now and then. Three pilot commits failed that way, and those two repositories were replayed again.

Made after the full run's replay (2026-10-14). It changes no criterion and no measure.

6. **Infrastructure failures replayed again.**
   - **What went wrong:** 1,538 of the 21,041 sampled commits (in 435 repositories) failed for a reason other than their migrations:
     - 1,535 failed in git;
     - 3 lost the database connection.
   - **Cause:** every lazy blob fetch adds a pack to the clone. Past git's pack limit, automatic maintenance repacked the clone while the replay was still reading it. The read then failed with "in the commit graph file but not in the object database". The replay classed those commits as unreplayable. They were 12% of all failed commits (1,538 of 12,699), and 50 were a repository's HEAD.
   - **Fix:** automatic maintenance is off in the clones (`gc.auto=0`, `maintenance.auto=false`, `fetch.writeCommitGraph=false`). `study/repair.ts` replays those commits again in place. A commit that fails the same way twice keeps its failure.
   - **Kept:** the results before the repair stay in `study/private/`.
   - **Cap recheck:** it was stopped after its first repository and finished with the fix in place.
