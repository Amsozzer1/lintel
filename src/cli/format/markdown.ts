/**
 * Markdown for PR comments. Every value that came from a database (identifiers, details)
 * is untrusted: a table can be named `</details><img src=…>` or `@everyone`.
 */
import { DOCS_BASE } from "../../core/errors.ts";
import type { Diff, FailOn, Finding } from "../../core/findings.ts";
import { atOrAbove } from "../../core/findings.ts";

export const COMMENT_MARKER = "<!-- lintel:v1";
/** GitHub rejects comments over 65,536 characters. */
const MAX_LENGTH = 60_000;
const ZWSP = "​";
const LEVEL_ICON = { error: "🔴 error", warn: "🟠 warn", info: "🔵 info" } as const;

type Entry = [fingerprint: string, label: string];

/** Carried between runs in the comment's hidden marker. */
export interface CommentState {
  /** Findings that were new on this run. */
  new: Entry[];
  /** Findings this PR introduced on an earlier push and has since fixed. Accumulates across pushes. */
  fixed: Entry[];
}

export interface MarkdownOptions {
  failOn: FailOn;
  baseLabel?: string;
  headLabel?: string;
  previous?: CommentState | undefined;
  suppressionsAdded?: string[];
}

/** Neutralize HTML, markdown table syntax, mentions, issue refs and autolinks. */
export function mdText(value: string): string {
  return (
    value
      .replace(/[\r\n\t]+/g, " ")
      // Break mentions, issue refs and autolinks first, so later entities (&#96;) stay intact.
      .replace(/([@#])/g, `$1${ZWSP}`)
      .replace(/:\/\//g, `:${ZWSP}//`)
      .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${ZWSP}.`)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\|/g, "&#124;")
      .replace(/`/g, "&#96;")
      .replace(/([\\*_~[\]])/g, "\\$1")
  );
}

const code = (value: string) => `<code>${mdText(value)}</code>`;

export function objectLabel(f: Finding): string {
  const { schema, name } = f.object;
  return [schema, name].filter(Boolean).join(".") || "(database)";
}

const SAFE_URL = /^[\w\-./?=&#%:]*$/;

/** Only link to Supabase's docs or Lintel's own; anything else is untrusted text. */
function remediationLink(f: Finding): string {
  const url = f.remediation;
  if (!url || !SAFE_URL.test(url)) return "";
  if (url.startsWith("https://supabase.com/") || url.startsWith(`${DOCS_BASE}/`))
    return `[docs](${url})`;
  return "";
}

/** Messages quote identifiers in backticks; render those parts as code, escaping everything. */
export function mdMessage(message: string): string {
  return message
    .split("`")
    .map((part, i) => (i % 2 === 1 ? code(part) : mdText(part)))
    .join("");
}

function row(f: Finding): string {
  const proof = f.source === "probe" ? " **(proven)**" : "";
  return `| ${LEVEL_ICON[f.level]} | ${code(f.rule)} | ${code(objectLabel(f))} | ${mdMessage(f.message)}${proof} ${remediationLink(f)} |`;
}

/** Budget for the hidden state so it can never push the comment over GitHub's limit. */
const STATE_BUDGET = 16_000;

const entryOf = (f: Finding): Entry => [
  f.fingerprint,
  `${f.rule} on ${objectLabel(f)}`.slice(0, 120),
];

/** What this PR has fixed so far: everything it introduced earlier that is no longer new. */
export function nextState(diff: Diff, previous: CommentState | undefined): CommentState {
  const currentNew = new Set(diff.new.map((f) => f.fingerprint));
  const fixed = new Map<string, string>();
  for (const [fp, label] of [...(previous?.fixed ?? []), ...(previous?.new ?? [])]) {
    if (!currentNew.has(fp)) fixed.set(fp, label);
  }
  return { new: diff.new.map(entryOf), fixed: [...fixed] };
}

export function encodeState(state: CommentState): string {
  const kept: CommentState = { new: [], fixed: [] };
  let size = 0;
  for (const key of ["new", "fixed"] as const) {
    for (const entry of state[key]) {
      // base64 grows by 4/3; stop before the budget rather than truncating mid-entry.
      size += Math.ceil((JSON.stringify(entry).length + 1) * (4 / 3));
      if (size > STATE_BUDGET) break;
      kept[key].push(entry);
    }
  }
  return Buffer.from(JSON.stringify(kept)).toString("base64url");
}

/** Parse the state from a previous comment body. Defensive: returns undefined on anything unexpected. */
export function decodeState(body: string): CommentState | undefined {
  const m = /<!-- lintel:v1 ([A-Za-z0-9_-]{0,200000}) -->/.exec(body);
  if (!m?.[1]) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entries = (v: unknown): Entry[] =>
      Array.isArray(v)
        ? v
            .filter(
              (e): e is Entry =>
                Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string",
            )
            .slice(0, 1000)
        : [];
    const { new: n, fixed } = parsed as Record<string, unknown>;
    if (!Array.isArray(n)) return undefined;
    return { new: entries(n), fixed: entries(fixed) };
  } catch {
    return undefined;
  }
}

export function renderDiffMarkdown(diff: Diff, opts: MarkdownOptions): string {
  const failing = atOrAbove(diff.new, opts.failOn);
  const state = nextState(diff, opts.previous);
  const fixed = state.fixed;

  const lines: string[] = [`${COMMENT_MARKER} ${encodeState(state)} -->`];
  const count = diff.new.length;
  lines.push(
    failing.length > 0
      ? `### ❌ Lintel: ${count} new ${count === 1 ? "finding" : "findings"}`
      : count > 0
        ? `### ✅ Lintel: ${count} new below the \`${opts.failOn}\` threshold`
        : "### ✅ Lintel: no new findings",
  );
  if (opts.baseLabel && opts.headLabel) {
    lines.push(
      `<sub>${mdText(opts.baseLabel)} → ${mdText(opts.headLabel)} · static findings from Supabase advisors, proofs from Lintel probes</sub>`,
    );
  }

  const rows = diff.new.map(row);
  if (rows.length) {
    lines.push("", "| Level | Rule | Object | Finding |", "|---|---|---|---|");
    let used = lines.join("\n").length;
    let shown = 0;
    for (const r of rows) {
      if (used + r.length > MAX_LENGTH) break;
      lines.push(r);
      used += r.length + 1;
      shown++;
    }
    if (shown < rows.length) {
      lines.push(
        "",
        `…and ${rows.length - shown} more. The full list is in the workflow's \`lintel-findings\` artifact.`,
      );
    }
  }

  const summary: string[] = [];
  if (fixed.length) summary.push(`✅ **${fixed.length} fixed in this PR**`);
  if (diff.resolved.length) summary.push(`${diff.resolved.length} resolved vs base`);
  summary.push(`${diff.unchanged.length} unchanged`);
  lines.push("", summary.join(" · "));

  if (fixed.length) {
    lines.push(
      "",
      "<details><summary>Fixed in this PR</summary>",
      "",
      ...fixed.map(([, label]) => `- ${mdText(label)}`),
      "",
      "</details>",
    );
  }
  if (opts.suppressionsAdded?.length) {
    lines.push(
      "",
      `> ⚠️ This PR adds ${opts.suppressionsAdded.length} suppression(s). Review them like code:`,
      ...opts.suppressionsAdded.map((s) => `> - ${mdText(s)}`),
    );
  }
  lines.push(
    "",
    "<sub>Run it locally: <code>lintel migrations check</code> · <code>lintel explain &lt;rule&gt;</code></sub>",
  );
  return `${lines.join("\n")}\n`;
}
