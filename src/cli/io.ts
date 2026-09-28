import pc from "picocolors";
import { type LintelError, toLintelError } from "../core/errors.ts";
import { redact } from "../core/redact.ts";

/** The only way the CLI writes. Every byte goes through redaction. */
export const out = (text: string): void => {
  process.stdout.write(redact(text.endsWith("\n") ? text : `${text}\n`));
};
export const err = (text: string): void => {
  process.stderr.write(redact(text.endsWith("\n") ? text : `${text}\n`));
};

export function printError(e: unknown, json: boolean): LintelError {
  const le = toLintelError(e);
  if (json) {
    out(JSON.stringify({ error: le.toJSON() }, null, 2));
    return le;
  }
  const lines = [`${pc.red(pc.bold("error"))} ${pc.bold(le.code)}: ${le.message}`];
  if (le.likelyCause) lines.push(`  ${pc.dim("likely cause:")} ${le.likelyCause}`);
  if (le.next) lines.push(`  ${pc.dim("try:")} ${pc.cyan(le.next)}`);
  if (le.details)
    lines.push(`  ${pc.dim("details:")} ${le.details.trim().split("\n").join("\n           ")}`);
  lines.push(`  ${pc.dim("docs:")} ${le.docsUrl}`);
  err(lines.join("\n"));
  return le;
}
