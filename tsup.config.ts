import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: true,
  sourcemap: false,
  clean: true,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
