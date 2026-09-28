-- A small chat app: profiles, rooms, membership, and a public blog.
-- This is the clean baseline the demo PR is compared against.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles are readable by signed-in users"
  on public.profiles for select to authenticated
  using (true);
create policy "users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create table public.rooms (
  id bigint generated always as identity primary key,
  name text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
create index rooms_created_by_idx on public.rooms (created_by);
alter table public.rooms enable row level security;

create table public.room_members (
  room_id bigint not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (room_id, user_id)
);
create index room_members_user_id_idx on public.room_members (user_id);
alter table public.room_members enable row level security;

create policy "members see their memberships"
  on public.room_members for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "members see their rooms"
  on public.rooms for select to authenticated
  using (exists (
    select 1 from public.room_members m
    where m.room_id = rooms.id and m.user_id = (select auth.uid())
  ));

create table public.blog_posts (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  published_at timestamptz
);
alter table public.blog_posts enable row level security;

create policy "published posts are public"
  on public.blog_posts for select to anon, authenticated
  using (published_at is not null);
