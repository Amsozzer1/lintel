import { describe, expect, it } from "vitest";
import { dbLabel, resolveDb } from "../../src/cli/options.ts";

describe("dbLabel", () => {
  it("never includes the user or password, even when the password contains @", () => {
    expect(dbLabel("postgresql://postgres:p@ss@db.example.com:5432/postgres?sslmode=require")).toBe(
      "db.example.com:5432/postgres",
    );
  });
});

describe("resolveDb", () => {
  it("reads env:NAME", () => {
    process.env.LINTEL_TEST_URL = "postgresql://h/db";
    expect(resolveDb("env:LINTEL_TEST_URL")).toBe("postgresql://h/db");
  });

  it("explains how to fix a missing variable", () => {
    delete process.env.LINTEL_MISSING;
    expect(() => resolveDb("env:LINTEL_MISSING")).toThrow(/LINTEL_MISSING is not set/);
  });
});
