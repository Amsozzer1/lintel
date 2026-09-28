/** Run dependency-cruiser and fail if it analyzed nothing: a layering gate that checks zero files must not pass. */
import { execFileSync } from "node:child_process";

const raw = execFileSync("npx", ["depcruise", "src", "--output-type", "json"], {
  encoding: "utf8",
});
const result = JSON.parse(raw.slice(raw.indexOf("{"))) as {
  summary: {
    totalCruised: number;
    error: number;
    violations: Array<{ from: string; to: string; rule: { name: string } }>;
  };
};
const { totalCruised, error, violations } = result.summary;
for (const v of violations) console.error(`✗ ${v.rule.name}: ${v.from} → ${v.to}`);
if (totalCruised < 5) {
  console.error(
    `dependency-cruiser analyzed only ${totalCruised} modules; the parser is probably not working`,
  );
  process.exit(1);
}
console.log(`dependency rules: ${totalCruised} modules checked, ${error} violations`);
process.exit(error > 0 ? 1 : 0);
