# Results: 1,000 public Supabase repositories, replayed

Method, criteria and every change after collection: [README.md](README.md). Data: [`data/`](data/). Collected 2026-10-13 to 2026-10-14.

> **Status: provisional.** 13 sampled commits of one repository (`repo-286`) are still being replayed after an infrastructure fix (README, change 6). Its migrations take 30 to 60 minutes per commit. Until it finishes, those commits count as replay failures. That one repository can't move a headline number by more than 0.3 points.

## In one paragraph

Of the 777 repositories with at least one migration commit that replays, **146 (18.8%) had a table the public `anon` key could read in full at some point**: RLS was off, and `anon` could select. Of the 393 whose latest commit replays, **43 (10.9%) still do**. When an exposure ended, it had usually lasted more than a day: 67% of them did, and 37% lasted more than a week. Counting the exposures that are still open, the median exposure lasted 47 days (Kaplan–Meier).

These are statements about the SQL in public migration files, replayed into a local database. They aren't statements about any live project (see [Limitations](#limitations)).

## Sample

| Step | Repositories |
|---|---|
| Candidates from GitHub code search (8 size slices) | 5,865 |
| Screened, in seeded random order | 1,158 |
| Rejected: fewer than 2 migration commits | 74 |
| Rejected: fewer than 3 migration files | 66 |
| Rejected: template repository | 11 |
| Rejected: template or tutorial keyword | 7 |
| **Eligible, and the sample** | **1,000** |
| Couldn't be cloned at replay (deleted or made private since screening) | 5 |
| At least one sampled commit replays | 777 (77.7%) |
| The latest (HEAD) commit replays | 393 (39.3%) |

The sample is young and small:

- **Age:** 72% of the repositories were created in 2026 and 25% in 2025.
- **Stars:** 79% have no stars, and the median is 0.
- **Homepage:** 57% list one.
- **History:** the median repository has 30 commits that touch its migrations, and half have more than 30. The interquartile range is 10 to 86, and the largest has 2,529.

## Primary measure: a table without RLS that `anon` can select

| | Repositories | Share | 95% CI (Wilson) |
|---|---|---|---|
| Ever, at any sampled commit | 146 of 777 | **18.8%** | 16.2 to 21.7% |
| At HEAD | 43 of 393 | **10.9%** | 8.2 to 14.4% |

**Denominators:**

- "Ever" is over the 777 repositories (77.7% of the sample) with at least one commit that replays.
- "At HEAD" is over the 393 (39.3%) whose latest commit replays.

**Not counted either way:** 43 more repositories were still exposing a table at their last commit that replays, but their HEAD doesn't replay. Their state at HEAD is unknown, so they aren't in the at-HEAD figure in either direction.

## Secondary measures

Each one is reported on its own; none is folded into the primary measure. Same denominators.

| Measure | Ever | At HEAD |
|---|---|---|
| Always-true policy lint that applies to `anon` (Splinter's `rls_policy_always_true`) | 72 of 777, 9.3% [7.4, 11.5] | 28 of 393, 7.1% [5.0, 10.1] |
| `SELECT` (or `ALL`) policy for `anon` whose `USING` is literally `true`, on a table with RLS on | 378 of 777, 48.6% [45.1, 52.2] | 175 of 393, 44.5% [39.7, 49.5] |
| Lintel P001: `anon` read rows in the replayed database | 288 of 777, 37.1% [33.7, 40.5] | 148 of 393, 37.7% [33.0, 42.5] |
| View or materialized view `anon` can select that bypasses RLS (not `security_invoker`) | 122 of 777, 15.7% [13.3, 18.4] | 42 of 393, 10.7% [8.0, 14.1] |

How to read them:

- **Splinter's lint** skips `SELECT` policies on purpose. What it catches here is mostly `anon` being allowed to write: insert, update or delete.
- **A `true` SELECT policy** is often deliberate, for public profiles, posts or listings. It's a measure of how often everything is opened up for reading, not a count of mistakes.
- **P001** depends on the seed data: it can only prove a read when the repository's `seed.sql` puts rows in the table. It includes deliberate public reads.
- **Views:** a view that isn't `security_invoker` runs with its owner's rights, so it can expose rows that the table's RLS would hide.

## How long exposures lasted

Durations use committer dates. The unit is the repository: an exposure runs from the first commit where any table is exposed to the first later commit where none is. Per-table figures follow below and are in `data/n1000-exposures.csv`.

| | Repository-level exposures |
|---|---|
| Total, in 146 repositories | 161 |
| Ended (all tables fixed or dropped) | 75 |
| Still open at the last commit that replays | 86 |
| Ended exposures that lasted more than 1 day | 50 of 75 (66.7%) |
| Ended exposures that lasted more than 7 days | 28 of 75 (37.3%) |
| All exposures known to have lasted more than 1 day | 108 of 161 (67.1%) |
| All exposures known to have lasted more than 7 days | 78 of 161 (48.4%) |
| Ended at the next migration commit | 22 |
| **Median (Kaplan–Meier, open exposures censored)** | **46.9 days; 25 migration commits** |

"Known to have lasted" counts an exposure that is still open only once it has already passed the threshold.

**Distribution:**

| Duration | Ended | Still open (so far) |
|---|---|---|
| Under 1 hour | 8 | 17 |
| 1 hour to 1 day | 17 | 11 |
| 1 to 7 days | 22 | 8 |
| 7 to 30 days | 9 | 12 |
| 30 to 90 days | 13 | 17 |
| 90 to 365 days | 5 | 20 |
| Over 1 year | 1 | 1 |

**Per table:**

- There were 1,269 table-level exposures:
  - 517 were fixed: RLS turned on or the grant revoked;
  - 80 were removed: the table was dropped;
  - 672 were still open.
- 68.7% of the ones that ended lasted more than a day, and 48.2% more than a week.
- The Kaplan–Meier median is 46.9 days.

**Rewritten history:** 33 repositories (3.3%) have history that was rewritten, either with committer dates that go backwards or with a commit committed more than a day after it was authored. They contain 11 of the 161 repository-level exposures. Their durations in days are less reliable. Their durations in commits are unaffected.

## Did the 30-commit cap miss anything?

495 of the 995 replayed repositories have more than 30 migration commits. For those, the replay sampled 30 of them: the first, the last and evenly spaced ones in between.

25 of them, drawn at random with a separate seed, were replayed again with no cap: 3,026 commits.

- **Which repositories are exposed:** no change. Each of the 25 has the same "ever exposed" result with and without the cap.
- **Tables:**
  - The uncapped replays found 30 exposed tables, 29 of which the capped replays had also found.
  - The one missed was in a repository that the cap already counted as exposed.
- **Start of an exposure:** 12 of the 30 started earlier without the cap:
  - 10 by one commit (under 0.1 days);
  - one by 3 commits (0.37 days);
  - one by 10 commits (0.92 days).
- **Durations:** in the 6 rechecked repositories with a repository-level exposure, the uncapped durations are within 0.75 days of the capped ones. One exposure that the capped replay left open turned out to have ended after 2.1 days.

The cap can shorten a duration by up to about a day, by catching the start late. It didn't change any repository's classification.

## Why commits don't replay

21,041 commits were sampled and 8,650 (41.1%) replayed. A commit that doesn't replay is left out of the timelines, and its reason is kept.

| Reason | Commits |
|---|---|
| Refers to a table, column, function, type or schema that doesn't exist when the migration runs (usually made outside the migrations, in the dashboard) | 8,510 |
| Other SQL error | 1,645 |
| Other | 1,265 |
| Raised by the migration itself (`RAISE EXCEPTION`, e.g. "run this after X") | 464 |
| Permission denied | 425 |
| Extension that isn't in the Supabase image | 60 |
| Infrastructure (git or Docker) after one retry; 13 of these are `repo-286`'s commits still being replayed | 22 |

At HEAD, 415 of the 602 repositories whose latest commit doesn't replay fail because of an object created outside the migrations (69%). Their migration files on their own don't rebuild their database. That is the main reason only 39% of HEADs replay.

## Limitations

- **Migrations aren't the deployed database.**
  - A project can turn on RLS or revoke grants in the dashboard without a migration, and then it looks exposed here when it isn't.
  - The reverse happens too: a table created in the dashboard never appears here.
  - Nothing here was checked against a live project, by design.
- **Replayability:**
  - The at-HEAD figure covers only the 39% of repositories whose HEAD replays.
  - Those may differ from the rest. Keeping everything in migrations is itself a habit, and it may go along with other habits.
  - 43 repositories were still exposed at their last commit that replays, but their HEAD doesn't replay. Suppose they're added to the 393. If none of them is still exposed at HEAD, the at-HEAD share is 43 of 436 (9.9%). If all of them are, it's 86 of 436 (19.7%).
- **Who's in the sample:**
  - Public repositories found by code search, with a root-level `supabase/` folder.
  - Mostly young, mostly unstarred projects.
  - Monorepos with `supabase/` deeper down aren't included.
  - Public repositories skew toward hobby, demo and portfolio projects, even after the keyword filter.
- **"Exposed" means a role, not a request.** It means the `anon` role has `SELECT` and RLS is off in the replayed database. Nobody requested anything from a real project.
- **P001 depends on seed data.** It can only prove a read where `seed.sql` puts rows in the table.
- **Sampling between commits:** above 30 commits per repository, an exposure can start between sampled commits. The [cap recheck](#did-the-30-commit-cap-miss-anything) puts that at about a day at most, with no change to which repositories are counted.
- **One infrastructure fix after collection.** 1,538 commits first failed in git, inside the replay, and were replayed again. The fix and its effect are in README change 6.

## Data

All repository names are replaced by `repo-NNN`, table names by salted hashes, and dates by days since each repository's first migration commit.

| File | One row per |
|---|---|
| `data/n1000-summary.json` | Every number on this page |
| `data/n1000-commits.csv` | Sampled commit: replayed or not, failure class, exposure counts, seconds |
| `data/n1000-exposures.csv` | Table or view exposure: start, end, outcome, length in commits and days |
| `data/n1000-repo-exposures.csv` | Repository-level exposure |
