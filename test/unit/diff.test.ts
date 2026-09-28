import { describe, expect, it } from "vitest";
import { diffReports, probeFingerprint } from "../../src/core/diff.ts";
import { atOrAbove } from "../../src/core/findings.ts";
import { finding, report } from "./helpers.ts";

describe("diffReports", () => {
  const a = finding({ fingerprint: "advisor:a" });
  const b = finding({ fingerprint: "advisor:b", level: "warn" });
  const c = finding({ fingerprint: "advisor:c", level: "info" });

  it("splits findings into new, resolved and unchanged by fingerprint", () => {
    const d = diffReports(report([a, b]), report([b, c]));
    expect(d.new.map((f) => f.fingerprint)).toEqual(["advisor:c"]);
    expect(d.resolved.map((f) => f.fingerprint)).toEqual(["advisor:a"]);
    expect(d.unchanged.map((f) => f.fingerprint)).toEqual(["advisor:b"]);
  });

  it("ignores message changes when the fingerprint is stable", () => {
    const moved = { ...a, message: "different wording" };
    expect(diffReports(report([a]), report([moved])).new).toEqual([]);
  });

  it("sorts new findings by severity", () => {
    const d = diffReports(report([]), report([c, a, b]));
    expect(d.new.map((f) => f.level)).toEqual(["error", "warn", "info"]);
  });
});

describe("atOrAbove", () => {
  const all = [
    finding({ fingerprint: "1" }),
    finding({ fingerprint: "2", level: "warn" }),
    finding({ fingerprint: "3", level: "info" }),
  ];
  it.each([
    ["error", 1],
    ["warn", 2],
    ["info", 3],
    ["none", 0],
  ] as const)("--fail-on %s counts %i findings", (level, n) => {
    expect(atOrAbove(all, level)).toHaveLength(n);
  });
});

describe("probeFingerprint", () => {
  it("does not collide on quoted names containing dots", () => {
    expect(probeFingerprint("P001", "a.b", "c")).not.toBe(probeFingerprint("P001", "a", "b.c"));
  });
});
