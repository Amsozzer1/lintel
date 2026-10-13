create type @extschema@.http_header as (field varchar, value varchar);
create type @extschema@.http_request as (method varchar, uri varchar, headers @extschema@.http_header[], content_type varchar, content varchar);
create type @extschema@.http_response as (status integer, content_type varchar, headers @extschema@.http_header[], content varchar);
create function @extschema@.http(request @extschema@.http_request) returns @extschema@.http_response language sql as $$ select null::@extschema@.http_response $$;
create function @extschema@.http_get(uri varchar) returns @extschema@.http_response language sql as $$ select null::@extschema@.http_response $$;
create function @extschema@.http_post(uri varchar, content varchar, content_type varchar) returns @extschema@.http_response language sql as $$ select null::@extschema@.http_response $$;
create function @extschema@.http_header(field varchar, value varchar) returns @extschema@.http_header language sql as $$ select row(field, value)::@extschema@.http_header $$;
