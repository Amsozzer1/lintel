-- Chat messages for rooms.
create table public.messages (
  id bigint generated always as identity primary key,
  room_id bigint not null references public.rooms (id) on delete cascade,
  author_id uuid not null references auth.users (id),
  body text not null,
  created_at timestamptz not null default now()
);
create index messages_room_id_idx on public.messages (room_id);
create index messages_author_id_idx on public.messages (author_id);

create policy "anyone can read messages"
  on public.messages for select
  using (true);
