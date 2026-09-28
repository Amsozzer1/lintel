import { describe, expect, it } from "vitest";
import {
  decodeState,
  mdMessage,
  mdText,
  renderDiffMarkdown,
} from "../../src/cli/format/markdown.ts";
import { diffReports } from "../../src/core/diff.ts";
import { finding, report } from "./helpers.ts";

describe("mdText", () => {
  it("neutralizes HTML, table pipes, mentions, issue refs and autolinks", () => {
    const hostile =
      "</details><img src=x onerror=alert(1)>|@everyone #1 https://evil.example www.evil.example `x`";
    const out = mdText(hostile);
    expect(out).not.toMatch(/<img|<\/details>/);
    expect(out).not.toContain("|");
    expect(out).not.toContain("@everyone");
    expect(out).not.toMatch(/(^|\s)#1/);
    expect(out).toContain("#\u200b1");
    expect(out).not.toContain("https://evil");
    expect(out).not.toContain("www.evil");
    expect(out).not.toContain("`");
  });
});

describe("mdText entity safety", () => {
  it("keeps the entities it creates intact", () => {
    expect(mdText("a`b|c")).toBe("a&#96;b&#124;c");
  });
});

describe("mdMessage", () => {
  it("renders backtick-quoted identifiers as escaped code", () => {
    expect(mdMessage("Table `public.a_b` is public")).toBe(
      "Table <code>public.a\\_b</code> is public",
    );
    expect(mdMessage("Table `<img>` x")).not.toContain("<img>");
  });
});

describe("renderDiffMarkdown", () => {
  const leak = finding({
    fingerprint: "advisor:leak",
    object: { schema: "public", name: "messages</td><script>", kind: "table" },
    remediation:
      "https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public",
  });

  it("fails loudly on new findings at the threshold and escapes identifiers", () => {
    const md = renderDiffMarkdown(diffReports(report([]), report([leak])), { failOn: "error" });
    expect(md).toContain("❌ Lintel: 1 new finding");
    expect(md).not.toContain("<script>");
    expect(md).toContain("[docs](https://supabase.com/docs/");
  });

  it("does not link remediation URLs outside supabase.com", () => {
    const evil = { ...leak, remediation: "https://evil.example/x" };
    const md = renderDiffMarkdown(diffReports(report([]), report([evil])), { failOn: "error" });
    expect(md).not.toContain("](https://evil");
  });

  it("keeps showing what the PR fixed, across later pushes", () => {
    const first = renderDiffMarkdown(diffReports(report([]), report([leak])), { failOn: "error" });
    expect(decodeState(first)?.new).toHaveLength(1);

    const fixedPush = renderDiffMarkdown(diffReports(report([]), report([])), {
      failOn: "error",
      previous: decodeState(first),
    });
    expect(fixedPush).toContain("✅ Lintel: no new findings");
    expect(fixedPush).toContain("1 fixed in this PR");

    // An unrelated later push must not forget the fix.
    const laterPush = renderDiffMarkdown(diffReports(report([]), report([])), {
      failOn: "error",
      previous: decodeState(fixedPush),
    });
    expect(laterPush).toContain("1 fixed in this PR");
  });

  it("drops a fix from the list if the PR reintroduces the finding", () => {
    const fixedPush = renderDiffMarkdown(diffReports(report([]), report([])), {
      failOn: "error",
      previous: { new: [["advisor:leak", "x"]], fixed: [] },
    });
    const again = renderDiffMarkdown(diffReports(report([]), report([leak])), {
      failOn: "error",
      previous: decodeState(fixedPush),
    });
    expect(again).not.toContain("fixed in this PR");
    expect(again).toContain("1 new finding");
  });

  it("links Lintel's own docs but not arbitrary hosts", () => {
    const probe = {
      ...leak,
      remediation: "https://github.com/Amsozzer1/lintel/blob/main/docs/probes.md#p001",
    };
    expect(
      renderDiffMarkdown(diffReports(report([]), report([probe])), { failOn: "error" }),
    ).toContain("[docs](https://github.com/Amsozzer1/lintel/blob/main/docs/probes.md#p001)");
  });

  it("stays under GitHub's comment size limit", () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      finding({
        fingerprint: `advisor:${i}`,
        message: "x".repeat(80),
        object: { schema: "public", name: `t${i}` },
      }),
    );
    const md = renderDiffMarkdown(diffReports(report([]), report(many)), { failOn: "error" });
    expect(md.length).toBeLessThan(65_536);
    expect(md).toMatch(/and \d+ more/);
  });

  it("ignores a tampered or malformed state marker", () => {
    expect(decodeState("<!-- lintel:v1 bm90IGpzb24 -->")).toBeUndefined();
    expect(decodeState("no marker")).toBeUndefined();
  });
});
