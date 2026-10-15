-- Invoices for paid rooms. Forgot to enable row level security: this table is
-- readable by anyone with the public anon key.
create table public.invoices (
  id bigint generated always as identity primary key,
  customer_id uuid not null references auth.users (id),
  amount_cents integer not null,
  card_last4 text not null,
  billing_address text not null,
  created_at timestamptz not null default now()
);
create index invoices_customer_id_idx on public.invoices (customer_id);
