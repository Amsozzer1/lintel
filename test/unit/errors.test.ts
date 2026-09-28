import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_CATALOG, errorsMarkdown, LintelError } from "../../src/core/errors.ts";
import { assertRepo } from "../../src/core/replay/git.ts";

describe("docs/errors.md", () => {
  it("has a section for every error code, at the anchor docs_url points to", () => {
    const md = errorsMarkdown();
    for (const code of Object.keys(ERROR_CATALOG)) {
      const anchor = new LintelError(code as keyof typeof ERROR_CATALOG, "x").docsUrl.split("#")[1];
      // GitHub anchors a `## LINTEL_E_X` heading as #lintel_e_x.
      expect(anchor).toBe(code.toLowerCase());
      expect(md).toContain(`\n## ${code}\n`);
    }
  });
});

describe("assertRepo", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lintel-repo-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const gitError = async (dir: string) => {
    const e = await assertRepo(dir).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(LintelError);
    return e as LintelError;
  };

  it("says the folder is missing, not that a ref is missing", async () => {
    const e = await gitError(join(root, "does-not-exist"));
    expect(e.code).toBe("LINTEL_E_GIT");
    expect(e.message).toMatch(/does not exist/);
    expect(e.message).not.toMatch(/ref/);
  });

  it("rejects a file path", async () => {
    const file = join(root, "a-file");
    await writeFile(file, "");
    expect((await gitError(file)).message).toMatch(/not a folder/);
  });

  it("rejects a folder outside any git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "lintel-plain-"));
    try {
      expect((await gitError(plain)).message).toMatch(/not inside a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("accepts a git repository", async () => {
    const repo = join(root, "repo");
    await execa("git", ["init", "-q", repo]);
    await expect(assertRepo(repo)).resolves.toBeUndefined();
  });
});
