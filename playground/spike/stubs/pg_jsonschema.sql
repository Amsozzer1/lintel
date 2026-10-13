create function @extschema@.json_matches_schema(schema json, instance json) returns boolean language sql immutable as $$ select true $$;
create function @extschema@.jsonb_matches_schema(schema json, instance jsonb) returns boolean language sql immutable as $$ select true $$;
create function @extschema@.jsonschema_is_valid(schema json) returns boolean language sql immutable as $$ select true $$;
