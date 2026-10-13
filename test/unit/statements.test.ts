import { describe, expect, it } from "vitest";
import {
  isPipelineIncompatible,
  migrationBatches,
  seedBatches,
  splitStatements,
  splitTokens,
} from "../../src/core/supabase/statements.ts";

/** Each case is the expected tokens; their concatenation is the input (supabase/cli `checkSplit`). */
const check = (tokens: string[]) =>
  expect(splitTokens(tokens.join("")).map((t) => t.text)).toEqual(tokens);

// Ported from supabase/cli v2.118.0 apps/cli-go/pkg/parser/state_test.go.
describe("splitTokens matches Supabase's parser", () => {
  const cases: Record<string, string[]> = {
    "line comment after separator": ["END;", "-- comment"],
    "line comment before separator": ["SELECT --; 1"],
    "line comment not started": ["- ;", "END"],
    "line comment between lines": ["-- /* \n;", " */ END"],
    "block comment contains separator": ["SELECT /* ; */ 1;"],
    "nested block comment": ["SELECT /*; /*;*/ ;*/ 1"],
    "block comment not started": ["/ * ;", " */ END"],
    "separator without spaces": [";", "END;", ";"],
    "separator between spaces": ["BEGIN   ;", "  END"],
    "backslash-escaped separator": ["\\;;", "\\;"],
    "named dollar tag": ["$tag$ any ; string$tag$"],
    "anonymous dollar tag": ['$$"Dane\'s horse"$$'],
    "dollar not started": ['SELECT "$";', " $$"],
    "single quote escapes separator": ["SELECT ';' 1"],
    "single quote preserved": ["SELECT ';'';' 1"],
    "literal backslash": ["SELECT '\\';", " 1'"],
    "double quote escapes separator": ['CREATE POLICY "cats;dogs" on cats_dogs;', " END"],
    "double quote keeps single quote": [`CREATE POLICY "cat's and dog's" on cats_dogs;`, " END"],
    "double quote keeps double quote": ['CREATE POLICY "pet""name" on pets;', " END"],
    parentheses: [
      'CREATE RULE notify_me AS ON UPDATE TO mytable DO (NOTIFY mytable; SELECT "1");',
      "SELECT 1",
    ],
    "parentheses ignore literals": [
      "CREATE RULE notify_me AS ON UPDATE TO mytable DO (-- )\nSELECT ')';\n-- )\n)\n",
    ],
    "begin atomic inline body": [
      "CREATE FUNCTION add(a integer, b integer) RETURNS integer\nLANGUAGE SQL\nIMMUTABLE STRICT PARALLEL SAFE\nRETURNS NULL ON NULL INPUT\nBEGIN ATOMIC\n\tSELECT 'add';\n\tSELECT a + b;\nEND;",
    ],
    "begin atomic is case insensitive": ["begin atomic; select 'end'; end"],
    "begin atomic ignores literals": [
      "CREATE FUNCTION test() BEGIN\nATOMIC-- END;\n-- END;\nEND\n;",
    ],
    "non-ASCII lookalike is not begin atomic": ["BEGIN atomıc;", " SELECT 'end';", " SELECT 2;"],
    "atomic body closes after a positional parameter": [
      "CREATE FUNCTION f(int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT $1;END;",
      " SELECT 2;",
    ],
    "nested atomic body inside parentheses": ["DO (BEGIN ATOMIC SELECT 1; END; );", " SELECT 2;"],
    "end after overlapping block comment": [
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; /* a /*/ b */ SELECT 2 END; SELECT 3; END;",
      " SELECT 4;",
    ],
    "schema-qualified atomic function name": [
      "CREATE OR REPLACE FUNCTION public.atomic_example()\nRETURNS INTEGER\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN 1;\nEND;\n$$;",
      "\nGRANT EXECUTE ON FUNCTION public.atomic_example() TO authenticated;",
    ],
  };
  for (const [name, tokens] of Object.entries(cases)) it(name, () => check(tokens));

  it.each(["a²", "a😀", "á"])("non-ASCII dollar tag %s", (tag) =>
    check([`$${tag}$ any ; END; string$${tag}$;`, " SELECT 2;"]),
  );

  it.each(["fn_atomic", "atomic_fn", "my_atomic_thing", "xatomicx", "fn_ATomiC"])(
    "atomic inside identifier %s",
    (name) =>
      check([
        `CREATE OR REPLACE FUNCTION ${name}()\nRETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  NULL;\nEND;\n$$;`,
        "\nSELECT 1;",
      ]),
  );

  const atomic = (body: string) =>
    `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC ${body}`;

  it.each([
    "pending",
    "pending_change",
    "append",
    "legend",
    "𐐀end",
    "😀end",
    "́end",
    "²end",
    "pending$$foo$",
  ])("end inside identifier %s", (name) =>
    check([atomic(`SELECT 1 AS ${name}; END;`), " SELECT 2;"]),
  );

  it.each(["endpoint", "end_date", "ended_at", "end𐐀", "end😀", "end́", "end²", "end$$foo$"])(
    "identifier starting with end: %s",
    (name) => check([atomic(`SELECT ${name}; SELECT 1; END;`), " SELECT 2;"]),
  );

  it.each([
    "CASE WHEN true THEN 1 ELSE 0 END",
    "case when true then 1 end",
    "CASE WHEN true THEN 1 END AS ended",
    "CASE WHEN CASE WHEN true THEN true END THEN 1 END",
    "(CASE WHEN (true) THEN 1 END)",
    "coalesce(CASE WHEN length('a') > 0 THEN 1 END, 0)",
    "CASE(1)WHEN 1 THEN 1 END",
    "1 AS case",
    "1 case",
    "1 AS end",
    "1 end",
    "'end'",
  ])("end inside inner statement: %s", (expr) =>
    check([atomic(`SELECT ${expr}; SELECT 1; END;`), " SELECT 2;"]),
  );

  it.each(["-- note END\n", "/* note; */ ", "\n/* a /* b; */ */ -- c\n"])(
    "atomic closes at END preceded only by a comment: %j",
    (comment) => check([atomic(`SELECT 1; ${comment}END;`), " SELECT 2;"]),
  );

  it.each([" ", "﻿", "\u0085"])("BEGIN %j ATOMIC needs SQL whitespace", (gap) =>
    check([`BEGIN ${gap} ATOMIC;`, " SELECT 1;", " end;", " SELECT 2;"]),
  );
});

describe("splitStatements", () => {
  it("trims like SplitAndTrim and keeps each statement's offset", () => {
    const sql = "\tBEGIN; \n  select 1 ;;\n-- trailing";
    const stmts = splitStatements(sql);
    expect(stmts.map((s) => s.text)).toEqual(["BEGIN", "select 1", "-- trailing"]);
    for (const s of stmts) expect(sql.slice(s.start, s.start + s.text.length)).toBe(s.text);
  });
});

describe("isPipelineIncompatible", () => {
  it.each([
    "create index concurrently i on t (a)",
    "CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)",
    "-- why\n/* note */ drop index concurrently i",
    "REINDEX (VERBOSE) TABLE t CONCURRENTLY",
    "vacuum",
    "VACUUM (ANALYZE) t",
    "alter system set work_mem = '1MB'",
    "cluster t using i",
  ])("runs alone: %j", (sql) => expect(isPipelineIncompatible(sql)).toBe(true));

  it.each(["create index i on t (a)", "select 'vacuum'", "create table concurrently_x (a int)"])(
    "stays in the batch: %j",
    (sql) => expect(isPipelineIncompatible(sql)).toBe(false),
  );
});

describe("migrationBatches", () => {
  it("groups statements into transactions around the ones that must run alone", () => {
    const sql =
      "create table a (id int);\ncreate index concurrently a_i on a (id);\ninsert into a values (1);\nselect 1;";
    expect(
      migrationBatches(sql).map((b) => [b.alone, b.statements.map((s) => s.text.split(" ")[0])]),
    ).toEqual([
      [false, ["create"]],
      [true, ["create"]],
      [false, ["insert", "select"]],
    ]);
  });

  it("sends a seed as one batch, even with statements a migration would split out", () => {
    const batches = seedBatches("insert into a values (1);\nvacuum;\n");
    expect(batches).toHaveLength(1);
    expect(batches[0]?.alone).toBe(false);
  });
});
