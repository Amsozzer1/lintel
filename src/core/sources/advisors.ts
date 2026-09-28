/**
 * Static findings come from Supabase's own linter via `supabase db advisors`.
 * Lintel does not re-implement those lints; it normalizes them so they can be diffed.
 */
import { execa } from "execa";
import { LintelError } from "../errors.ts";
import type { Finding, Level } from "../findings.ts";
import { redact, registerSecret, splitPassword } from "../redact.ts";

/** Lints driven by runtime statistics. On a freshly replayed database they fire on every new index or table. */
export const REPLAY_DENYLIST: ReadonlySet<string> = new Set(["unused_index", "table_bloat"]);

interface AdvisorLint {
  name: string;
  title: string;
  level: string;
  detail: string;
  remediation?: string;
  metadata: { schema?: string; name?: string; type?: string } | null;
  cacheKey: string;
}

interface SupabaseCliError {
  code: string;
  message: string;
  suggestion?: string;
}

export interface AdvisorOptions {
  supabaseBin?: string;
  replay?: boolean;
  timeoutMs?: number;
}

export async function runAdvisors(dbUrl: string, opts: AdvisorOptions = {}): Promise<Finding[]> {
  const { url, password } = splitPassword(dbUrl);
  registerSecret(password);
  const bin = opts.supabaseBin ?? process.env.LINTEL_SUPABASE_BIN ?? "supabase";
  // The password travels by environment, never argv, so it can't be read from the process list.
  const env: Record<string, string> = password
    ? { PGPASSWORD: password, SUPABASE_DB_PASSWORD: password }
    : {};
  // Pin the output contract explicitly: without these flags the CLI's JSON shape changes
  // depending on agent detection.
  const args = [
    "db",
    "advisors",
    "--db-url",
    url,
    "--type",
    "all",
    "--level",
    "info",
    "--output-format",
    "json",
    "--agent",
    "no",
  ];

  const result = await execa(bin, args, { env, reject: false, timeout: opts.timeoutMs ?? 180_000 });
  if (result.failed && result.exitCode === undefined) {
    if (result.timedOut) {
      throw new LintelError("LINTEL_E_SUPABASE_CLI", "supabase db advisors timed out", {
        next: "check that the database is reachable: psql <url> -c 'select 1'",
      });
    }
    throw cliMissing(bin, result.message);
  }

  const stdout = String(result.stdout ?? "").trim();
  const parsed = parseAdvisorOutput(stdout);
  if ("error" in parsed) throw mapSupabaseError(parsed.error);
  if (result.exitCode !== 0) {
    throw new LintelError(
      "LINTEL_E_SUPABASE_CLI",
      `supabase db advisors exited with ${result.exitCode}`,
      {
        details: redact(String(result.stderr ?? "")),
        next: "supabase db advisors --debug --db-url <url>",
      },
    );
  }
  return parsed.lints
    .filter((l) => !(opts.replay && REPLAY_DENYLIST.has(l.name)))
    .map(normalizeLint);
}

/** Accepts every shape the CLI has emitted: `{results:[…]}` or a bare array, `cacheKey` or `cache_key`. */
export function parseAdvisorOutput(
  stdout: string,
): { lints: AdvisorLint[] } | { error: SupabaseCliError } {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new LintelError(
      "LINTEL_E_SUPABASE_CLI",
      "could not parse `supabase db advisors` output as JSON",
      {
        cause: "an unsupported Supabase CLI version",
        next: "supabase --version  (Lintel is tested with 2.118)",
        details: redact(stdout.slice(0, 500)),
      },
    );
  }
  if (isObject(json) && json._tag === "Error" && isObject(json.error)) {
    return { error: json.error as unknown as SupabaseCliError };
  }
  const rows = Array.isArray(json)
    ? json
    : isObject(json) && Array.isArray(json.results)
      ? json.results
      : null;
  if (!rows) {
    throw new LintelError(
      "LINTEL_E_SUPABASE_CLI",
      "unexpected `supabase db advisors` output shape",
      {
        next: "supabase --version  (Lintel is tested with 2.118)",
      },
    );
  }
  return {
    lints: rows.filter(isObject).map((r) => ({
      name: String(r.name ?? ""),
      title: String(r.title ?? r.name ?? ""),
      level: String(r.level ?? "info"),
      detail: String(r.detail ?? ""),
      ...(typeof r.remediation === "string" ? { remediation: r.remediation } : {}),
      metadata: isObject(r.metadata) ? (r.metadata as AdvisorLint["metadata"]) : null,
      cacheKey: String(r.cacheKey ?? r.cache_key ?? ""),
    })),
  };
}

export function normalizeLint(l: AdvisorLint): Finding {
  const level = l.level.toLowerCase();
  const object = {
    ...(l.metadata?.schema ? { schema: l.metadata.schema } : {}),
    ...(l.metadata?.name ? { name: l.metadata.name } : {}),
    ...(l.metadata?.type ? { kind: l.metadata.type } : {}),
  };
  return {
    fingerprint: `advisor:${l.cacheKey || JSON.stringify([l.name, object.schema, object.name])}`,
    source: "advisor",
    rule: l.name,
    title: l.title,
    level: (level === "error" || level === "warn" ? level : "info") satisfies Level,
    object,
    message: l.detail,
    ...(l.remediation ? { remediation: l.remediation } : {}),
  };
}

export function mapSupabaseError(e: SupabaseCliError): LintelError {
  const message = redact(e.message);
  if (/28P01|password authentication failed/i.test(message)) {
    return new LintelError("LINTEL_E_AUTH", "the database rejected the password", {
      cause:
        "wrong password, or the wrong user for a pooler URL (it must be postgres.<project-ref>)",
      next: "copy the connection string again from the dashboard: Connect → Session pooler",
      details: message,
    });
  }
  if (/ECONNREFUSED/i.test(message)) {
    return new LintelError(
      "LINTEL_E_CONNECT",
      "nothing is accepting connections at that host and port",
      {
        cause: "the local stack isn't running, or the port is wrong",
        next: "supabase status   (or: supabase start)",
        details: message,
      },
    );
  }
  if (/ENETUNREACH|network is unreachable|no route to host/i.test(message)) {
    return new LintelError(
      "LINTEL_E_CONNECT",
      "the database host is unreachable from this network",
      {
        cause: "direct db.<ref>.supabase.co hosts are IPv6-only",
        next: "use the Session pooler connection string (IPv4) from the dashboard",
        details: message,
      },
    );
  }
  if (/certificate|SSL|TLS/i.test(message)) {
    return new LintelError("LINTEL_E_CONNECT", "the TLS handshake failed", {
      cause: "certificate verification failed or SSL is not enabled on the server",
      next: "for local databases add ?sslmode=disable; for hosted ones use the dashboard's connection string",
      details: message,
    });
  }
  if (/ENOTFOUND|getaddrinfo|no such host/i.test(message)) {
    return new LintelError("LINTEL_E_CONNECT", "the database host name does not resolve", {
      next: "check the host in your connection string",
      details: message,
    });
  }
  return new LintelError("LINTEL_E_SUPABASE_CLI", `supabase db advisors failed: ${e.code}`, {
    ...(e.suggestion ? { next: redact(e.suggestion) } : {}),
    details: message,
  });
}

function cliMissing(bin: string, err: unknown): LintelError {
  return new LintelError("LINTEL_E_SUPABASE_CLI", `could not run the Supabase CLI (\`${bin}\`)`, {
    cause: "the Supabase CLI is not installed or not on PATH",
    next: "brew install supabase/tap/supabase   (or: npm i -g supabase)",
    details: redact(err instanceof Error ? err.message : String(err ?? "")),
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
