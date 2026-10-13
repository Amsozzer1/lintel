/** Preloaded examples. Every one ships seed rows, so P001 can prove what anon reads. */
export interface Example {
  id: string;
  label: string;
  migration: string;
  seed: string;
}

const USERS = `insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ada@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com');
`;

const INVOICES = `create table public.invoices (
  id bigint generated always as identity primary key,
  customer_id uuid not null references auth.users (id),
  amount_cents integer not null,
  card_last4 text not null,
  created_at timestamptz not null default now()
);
create index invoices_customer_id_idx on public.invoices (customer_id);
`;

const INVOICE_ROWS = `${USERS}
insert into public.invoices (customer_id, amount_cents, card_last4) values
  ('11111111-1111-1111-1111-111111111111', 4900, '4242'),
  ('22222222-2222-2222-2222-222222222222', 4900, '1881');
`;

export const EXAMPLES: Example[] = [
  {
    id: "leaky",
    label: "Leaky table",
    migration: `-- Invoices, with row level security never enabled.\n${INVOICES}`,
    seed: INVOICE_ROWS,
  },
  {
    id: "fixed",
    label: "Fixed table",
    migration: `-- The same table, with RLS on and a policy: customers see their own invoices.\n${INVOICES}alter table public.invoices enable row level security;

create policy "customers read their invoices"
  on public.invoices for select to authenticated
  using ((select auth.uid()) = customer_id);
`,
    seed: INVOICE_ROWS,
  },
  {
    id: "true-for-anon",
    label: "using (true) for anon",
    migration: `-- RLS is on, but the policies let anyone with the anon key in.
create table public.feedback (
  id bigint generated always as identity primary key,
  email text not null,
  message text not null
);
alter table public.feedback enable row level security;

create policy "anyone can read feedback"
  on public.feedback for select to anon
  using (true);

create policy "anyone can send feedback"
  on public.feedback for insert to anon
  with check (true);
`,
    seed: `insert into public.feedback (email, message) values
  ('ada@example.com', 'the export button is broken again'),
  ('bob@example.com', 'please add dark mode');
`,
  },
  {
    id: "clean",
    label: "Clean",
    migration: `-- Profiles: signed-in users read all of them and edit only their own.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique
);
alter table public.profiles enable row level security;

create policy "signed-in users read profiles"
  on public.profiles for select to authenticated
  using (true);

create policy "users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
`,
    seed: `${USERS}
insert into public.profiles (id, username) values
  ('11111111-1111-1111-1111-111111111111', 'ada'),
  ('22222222-2222-2222-2222-222222222222', 'bob');
`,
  },
];
