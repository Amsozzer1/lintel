-- Chat messages for rooms. Only members of a room can read its messages.
create table public.messages (
  id bigint generated always as identity primary key,
  room_id bigint not null references public.rooms (id) on delete cascade,
  author_id uuid not null references auth.users (id),
  body text not null,
  created_at timestamptz not null default now()
);
create index messages_room_id_idx on public.messages (room_id);
create index messages_author_id_idx on public.messages (author_id);
alter table public.messages enable row level security;

create policy "members read their rooms' messages"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = messages.room_id and m.user_id = (select auth.uid())
  ));
