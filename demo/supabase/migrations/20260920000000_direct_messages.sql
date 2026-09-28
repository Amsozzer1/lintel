-- Private 1:1 messages between users.
create table public.direct_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references auth.users (id),
  recipient_id uuid not null references auth.users (id),
  body text not null,
  created_at timestamptz not null default now()
);
create index direct_messages_sender_idx on public.direct_messages (sender_id);
create index direct_messages_recipient_idx on public.direct_messages (recipient_id);
