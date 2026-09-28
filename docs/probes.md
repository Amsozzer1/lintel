# Probes

Supabase's advisors read the catalog and report what *looks* wrong. Probes run real queries as the roles your API uses and report what *actually* leaks.

Every probe runs inside `begin … rollback`, with `statement_timeout = 5s` and `lock_timeout = 2s`, and the session role is reset afterwards. `lintel check` runs probes only with `--probe`. `lintel ci` and `lintel migrations check` always run them, because they probe throwaway databases.

## P001

**anon can read rows**

For every table, view and materialized view the `anon` role can `SELECT` in an exposed schema (`--schema`, default `public`), Lintel:

1. counts the rows as the connecting role (up to 1,000);
2. runs `set local role anon`, sets anon JWT claims and counts again;
3. rolls back.

| Result | Level |
|---|---|
| anon sees rows because **RLS is disabled** | error |
| anon sees rows through a **view without `security_invoker`** (views run with their owner's rights and bypass RLS) | error |
| anon sees rows in a **materialized view** (materialized views have no RLS) | error |
| anon sees rows **because a policy allows it** | warn. Often intentional (a public blog). If it is, suppress it with a reason. |
| the relation has no rows | not a finding; listed as `unverified` in the report |

**How to fix.** Enable RLS and write a policy that scopes rows to the caller:

```sql
alter table public.messages enable row level security;

create policy "members read their rooms' messages"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = messages.room_id and m.user_id = (select auth.uid())
  ));
```

For views, use `create view … with (security_invoker = on)` so the caller's RLS applies.

**False positives.** Data that is meant to be public. Suppressions with a written reason are coming next.

## P002 · P003

In progress:
- **P002** will prove anon can change rows. It will run only in Lintel's throwaway databases.
- **P003** will prove one signed-in user can read another user's rows.
