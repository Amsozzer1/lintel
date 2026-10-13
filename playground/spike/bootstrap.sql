-- Mirrors the roles, schemas and default grants of supabase/postgres:17.6.1.013
-- (the image Lintel replays into). PGlite's `postgres` is a superuser; the image's is not.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create role supabase_admin login superuser;
create role supabase_auth_admin login noinherit;
create role supabase_storage_admin login noinherit;
create role dashboard_user nologin;

create schema auth;
create schema extensions;
create schema storage;
create schema graphql;
create schema graphql_public;
create schema realtime;
create schema vault;

grant usage on schema public, auth, extensions, storage, graphql, graphql_public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema storage grant all on tables to anon, authenticated, service_role;
alter default privileges in schema storage grant all on functions to anon, authenticated, service_role;
alter default privileges in schema storage grant all on sequences to anon, authenticated, service_role;

create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
create extension pg_stat_statements with schema extensions;
create publication supabase_realtime;
