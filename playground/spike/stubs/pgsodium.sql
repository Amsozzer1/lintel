create schema if not exists pgsodium;
create table pgsodium.key (id uuid primary key default gen_random_uuid(), name text, created timestamptz default now());
