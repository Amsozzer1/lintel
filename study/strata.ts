/**
 * The primary measure (a table without RLS that anon can select), ever and at HEAD, by stratum:
 * stars, creation year, and whether the project looks deployed.
 *
 *   node study/strata.ts <name> <raw dir>      # e.g. n1000 raw-n1000
 *
 * Reads private inputs (sample.json, readmes/, deployed-hand-check.json) and writes only counts to
 * study/data/<name>-strata.json. No URL is visited: the homepage field and README are read.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const [name = "n1000", rawDir = "raw-n1000"] = process.argv.slice(2);
const PRIVATE = new URL("private/", import.meta.url);
const DATA = new URL("data/", import.meta.url);

interface Sampled {
  repo: string;
  stars: number;
  created: string;
  homepage: string | null;
}
interface Commit {
  index: number;
  applied: boolean;
  exposed?: { kind: string; rls: boolean; tableSelect?: boolean }[];
}

const sample = JSON.parse(readFileSync(new URL("sample.json", PRIVATE), "utf8")) as Sampled[];
const handCheck: Record<string, "deployed" | "not deployed" | "unclear"> = existsSync(
  new URL("deployed-hand-check.json", PRIVATE),
)
  ? JSON.parse(readFileSync(new URL("deployed-hand-check.json", PRIVATE), "utf8"))
  : {};

// "Looks deployed", one rule for every repository:
// - the homepage field is a URL on a site that isn't a generic tool, platform or docs site; or
// - the README links an app on an app-hosting domain.
// A hand check (README and repository text only) overrides the rule where one was made.
const GENERIC =
  /(^|\.)(github\.com|githubusercontent\.com|supabase\.(com|co|io)|lovable\.(dev|app\/?$)|onspace\.ai|bolt\.new|v0\.dev|replit\.com|codecov\.io|ko-fi\.com|buymeacoffee\.com|patreon\.com|ohmyz\.sh|npmjs\.com|nodejs\.org|nextjs\.org|react\.dev|vitejs\.dev|nuxt\.com|flutter\.dev|tailwindcss\.com|vercel\.com|netlify\.com|google\.com|youtube\.com|linkedin\.com|x\.com|twitter\.com|discord\.(gg|com)|medium\.com|dev\.to|shields\.io|pnpm\.io)$/i;
const HOSTING =
  /\.(vercel\.app|netlify\.app|pages\.dev|workers\.dev|github\.io|lovable\.app|onrender\.com|fly\.dev|up\.railway\.app|web\.app|firebaseapp\.com|herokuapp\.com|replit\.app|surge\.sh|amplifyapp\.com|azurestaticapps\.net|streamlit\.app)$/i;
const PLACEHOLDER = /your[-_]|example|localhost|127\.0\.0\.1|<|\{|xxx|my-app|project-name/i;
const host = (u: string) => {
  try {
    return new URL(u.startsWith("http") ? u : `https://${u}`).hostname;
  } catch {
    return "";
  }
};
function looksDeployed(s: Sampled): boolean {
  const hand = handCheck[s.repo];
  if (hand) return hand === "deployed";
  const homepage = s.homepage?.trim();
  if (homepage && !PLACEHOLDER.test(homepage) && host(homepage) && !GENERIC.test(host(homepage)))
    return true;
  const file = new URL(`readmes/${s.repo.replace("/", "_")}__.md`, PRIVATE);
  const readme = existsSync(file) ? readFileSync(file, "utf8") : "";
  return [...readme.matchAll(/https?:\/\/[^\s)"'<>\]`]+/g)].some(
    (m) => !PLACEHOLDER.test(m[0]) && HOSTING.test(host(m[0])),
  );
}

const tables = (r: Commit) =>
  (r.exposed ?? []).some(
    (e) => (e.kind === "r" || e.kind === "p") && !e.rls && e.tableSelect !== false,
  );
const raws = new Map<string, Commit[]>();
for (const f of readdirSync(new URL(`${rawDir}/`, PRIVATE))) {
  const raw = JSON.parse(readFileSync(new URL(`${rawDir}/${f}`, PRIVATE), "utf8"));
  raws.set(
    raw.repo,
    [...(raw.results ?? [])].sort((a: Commit, b: Commit) => a.index - b.index),
  );
}

/** Wilson score interval, 95%. */
function wilson(n: number, d: number): [number, number] | null {
  if (!d) return null;
  const z = 1.96;
  const p = n / d;
  const den = 1 + (z * z) / d;
  const c = (p + (z * z) / (2 * d)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / d + (z * z) / (4 * d * d))) / den;
  const r = (x: number) => Math.round(1000 * x) / 10;
  return [r(Math.max(0, c - h)), r(Math.min(1, c + h))];
}
// A cell is too small to mean anything when its denominator is under 30 or it has fewer than 5
// repositories on either side of the measure.
const cell = (n: number, d: number) => ({
  n,
  of: d,
  pct: d ? Math.round((1000 * n) / d) / 10 : null,
  ci95: wilson(n, d),
  tooSmall: d < 30 || n < 5 || d - n < 5,
});

const STRATA: Record<string, [string, (s: Sampled) => boolean][]> = {
  stars: [
    ["0", (s) => s.stars === 0],
    ["1-9", (s) => s.stars >= 1 && s.stars <= 9],
    ["10+", (s) => s.stars >= 10],
  ],
  created: [
    ["before 2026", (s) => s.created < "2026"],
    ["2026", (s) => s.created >= "2026"],
  ],
  looksDeployed: [
    ["yes", (s) => looksDeployed(s)],
    ["no or unclear", (s) => !looksDeployed(s)],
  ],
};

const out: Record<string, unknown> = {
  note: "primary measure: a table without RLS that anon can select; ever over repositories with an applied commit, atHead over repositories whose HEAD replays; tooSmall when the denominator is under 30 or either side has fewer than 5",
};
for (const [stratum, groups] of Object.entries(STRATA)) {
  out[stratum] = Object.fromEntries(
    groups.map(([label, test]) => {
      const members = sample.filter(test);
      let everN = 0;
      let everD = 0;
      let headN = 0;
      let headD = 0;
      for (const s of members) {
        const results = raws.get(s.repo) ?? [];
        const applied = results.filter((r) => r.applied);
        if (applied.length) {
          everD++;
          if (applied.some(tables)) everN++;
        }
        const head = results.at(-1);
        if (head?.applied) {
          headD++;
          if (tables(head)) headN++;
        }
      }
      return [
        label,
        { repositories: members.length, ever: cell(everN, everD), atHead: cell(headN, headD) },
      ];
    }),
  );
}
writeFileSync(new URL(`${name}-strata.json`, DATA), `${JSON.stringify(out, null, 2)}\n`);
// Private: the flag per repository, for the disclosure list.
writeFileSync(
  new URL("looks-deployed.json", PRIVATE),
  `${JSON.stringify(Object.fromEntries(sample.map((s) => [s.repo, looksDeployed(s)])), null, 1)}\n`,
);
console.log(JSON.stringify(out, null, 1));
