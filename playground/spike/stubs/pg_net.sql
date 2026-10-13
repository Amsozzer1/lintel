create schema if not exists net;
create table net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz not null default now());
create sequence net.http_request_queue_id_seq;
create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select nextval('net.http_request_queue_id_seq') $$;
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select nextval('net.http_request_queue_id_seq') $$;
create function net.http_delete(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000, body jsonb default null) returns bigint language sql as $$ select nextval('net.http_request_queue_id_seq') $$;
grant usage on schema net to postgres, anon, authenticated, service_role;
