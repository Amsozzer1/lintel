-- Hosted-Supabase schema the bare image lacks: Auth and Storage add these with their own
-- migrations at runtime. Hand-written for the spike; production would generate it from a dump.
alter table auth.users
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists phone text unique default null,
  add column if not exists phone_confirmed_at timestamptz,
  add column if not exists phone_change text default '',
  add column if not exists phone_change_token varchar(255) default '',
  add column if not exists phone_change_sent_at timestamptz,
  add column if not exists email_change_token_current varchar(255) default '',
  add column if not exists email_change_token_new varchar(255),
  add column if not exists email_change_confirm_status smallint default 0,
  add column if not exists banned_until timestamptz,
  add column if not exists reauthentication_token varchar(255) default '',
  add column if not exists reauthentication_sent_at timestamptz,
  add column if not exists is_sso_user boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists is_anonymous boolean not null default false;
create table auth.identities (
  provider_id text not null, user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz,
  created_at timestamptz, updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  id uuid primary key default gen_random_uuid(), unique (provider_id, provider));
create table auth.sessions (
  id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz, updated_at timestamptz, factor_id uuid, aal text, not_after timestamptz,
  refreshed_at timestamp, user_agent text, ip inet, tag text);
create table auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade,
  friendly_name text, factor_type text not null, status text not null,
  created_at timestamptz not null, updated_at timestamptz not null, secret text);

create type storage.buckettype as enum ('STANDARD', 'ANALYTICS');
alter table storage.buckets
  add column if not exists public boolean default false,
  add column if not exists avif_autodetection boolean default false,
  add column if not exists file_size_limit bigint,
  add column if not exists allowed_mime_types text[],
  add column if not exists owner_id text,
  add column if not exists type storage.buckettype not null default 'STANDARD';
alter table storage.objects
  add column if not exists path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  add column if not exists version text,
  add column if not exists owner_id text,
  add column if not exists user_metadata jsonb,
  add column if not exists level int;
grant all on all tables in schema storage to anon, authenticated, service_role;
