/** Layer rules: the core never depends on a surface. */
module.exports = {
  forbidden: [
    {
      name: "core-is-surface-free",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "^src/(cli|api|mcp)" },
    },
    {
      name: "surfaces-are-independent",
      severity: "error",
      from: { path: "^src/(api|mcp)" },
      to: { path: "^src/cli" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // dependency-cruiser does not support TypeScript 7 yet; parse with swc instead.
    parser: "swc",
    tsPreCompilationDeps: true,
  },
};
