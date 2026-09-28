import { LintelError } from "../core/errors.ts";
import { FailOn } from "../core/findings.ts";
import { err } from "./io.ts";

export type Format = "human" | "json" | "markdown";

export function parseFormat(
  value: string | undefined,
  allowed: Format[] = ["human", "json", "markdown"],
): Format {
  const format = (value ?? "human") as Format;
  if (!allowed.includes(format)) {
    throw new LintelError("LINTEL_E_USAGE", `unknown --format \`${value}\``, {
      next: `use one of: ${allowed.join(", ")}`,
    });
  }
  return format;
}

export function parseFailOn(value: string | undefined): FailOn {
  const r = FailOn.safeParse(value ?? "error");
  if (!r.success) {
    throw new LintelError("LINTEL_E_USAGE", `unknown --fail-on \`${value}\``, {
      next: "use one of: error, warn, info, none",
    });
  }
  return r.data;
}

/**
 * `--db` accepts a URL or `env:NAME`. Defaults to $DATABASE_URL.
 * A literal URL with a password works, but we nudge toward env so it stays out of `ps` and shell history.
 */
export function resolveDb(value: string | undefined): string {
  const raw = value ?? "env:DATABASE_URL";
  if (raw.startsWith("env:")) {
    const name = raw.slice(4);
    const url = process.env[name];
    if (!url) {
      throw new LintelError("LINTEL_E_NO_DATABASE", `no database: $${name} is not set`, {
        next: `export ${name}='postgresql://…'   (or: lintel check --db env:OTHER_VAR)`,
      });
    }
    return url;
  }
  if (/^postgres(ql)?:\/\/[^:@/\s]*:[^@\s]+@/i.test(raw)) {
    err(
      "tip: pass --db env:DATABASE_URL to keep the password out of your shell history and process list",
    );
  }
  return raw;
}

/** A label for reports: host, port and database, never the user or password. */
export function dbLabel(url: string): string {
  const m = /^postgres(?:ql)?:\/\/(?:.*@)?([^@/?\s]+)(\/[^?\s]*)?/i.exec(url);
  return m ? `${m[1]}${m[2] ?? ""}` : "database";
}
