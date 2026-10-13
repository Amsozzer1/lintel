create function @extschema@.sign(payload json, secret text, algorithm text default 'HS256') returns text language sql as $$ select null::text $$;
create function @extschema@.verify(token text, secret text, algorithm text default 'HS256') returns table (header json, payload json, valid boolean) language sql as $$ select null::json, null::json, false $$;
