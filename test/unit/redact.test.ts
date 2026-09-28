import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redact, registerSecret, splitPassword } from "../../src/core/redact.ts";

// Real passwords contain characters that break URL parsers.
const passwordChars = fc.constantFrom(..."abcXYZ019@#/%?+:!$&*()=,;~'".split(""));
const password = fc.string({ unit: passwordChars, minLength: 4, maxLength: 40 });
const unicodePassword = fc
  .string({ unit: "grapheme", minLength: 4, maxLength: 20 })
  .filter((s) => !/\s/.test(s));

describe("redact", () => {
  it("masks raw (unencoded) passwords in connection strings, up to the last @", () => {
    fc.assert(
      fc.property(fc.oneof(password, unicodePassword), (pw) => {
        const url = `postgresql://postgres:${pw}@db.example.com:5432/postgres`;
        expect(redact(`failed: ${url} refused`)).toBe(
          "failed: postgresql://postgres:***@db.example.com:5432/postgres refused",
        );
      }),
    );
  });

  it("masks percent-encoded passwords", () => {
    fc.assert(
      fc.property(password, (pw) => {
        const url = `postgres://u:${encodeURIComponent(pw)}@h/db?sslmode=disable`;
        expect(redact(url)).toBe("postgres://u:***@h/db?sslmode=disable");
      }),
    );
  });

  it("masks libpq key/value strings, query params and env assignments", () => {
    expect(redact("host=h user=u password=s3cr3t dbname=d")).toBe(
      "host=h user=u password=*** dbname=d",
    );
    expect(redact("host=h password='with space' dbname=d")).toBe("host=h password=*** dbname=d");
    expect(redact("postgres://h/db?user=u&password=s3cr3t&x=1")).toBe(
      "postgres://h/db?user=u&password=***&x=1",
    );
    expect(redact("PGPASSWORD=hunter22 psql")).toBe("PGPASSWORD=*** psql");
  });

  it("masks registered secrets anywhere, raw or encoded", () => {
    registerSecret("p@ss#w/rd-registered");
    expect(redact("echoed p@ss#w/rd-registered back")).toBe("echoed *** back");
    expect(redact(`echoed ${encodeURIComponent("p@ss#w/rd-registered")} back`)).toBe(
      "echoed *** back",
    );
  });

  it("leaves text without secrets alone", () => {
    expect(redact("table public.messages has RLS disabled")).toBe(
      "table public.messages has RLS disabled",
    );
  });
});

describe("splitPassword", () => {
  it("round-trips raw and encoded passwords without a URL parser", () => {
    fc.assert(
      fc.property(password, (pw) => {
        for (const form of [pw, encodeURIComponent(pw)]) {
          const r = splitPassword(`postgresql://postgres:${form}@127.0.0.1:5432/postgres`);
          expect(r.url).toBe("postgresql://postgres@127.0.0.1:5432/postgres");
          if (form !== pw) expect(r.password).toBe(pw);
        }
      }),
    );
  });

  it("returns URLs without a password unchanged", () => {
    expect(splitPassword("postgresql://postgres@h/db")).toEqual({
      url: "postgresql://postgres@h/db",
      password: undefined,
    });
  });
});
