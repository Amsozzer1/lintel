import pg from "pg";
import { LintelError } from "./errors.ts";
import { redact, registerSecret, splitPassword } from "./redact.ts";

/**
 * Rebuild the URL with a correctly percent-encoded password. Real passwords contain raw `@ # /`,
 * which pg's parser would split in the wrong place. (A separate `password` option doesn't work:
 * pg lets the parsed connection string override it.)
 */
export function normalizeUrl(dbUrl: string): string {
  const { url, password } = splitPassword(dbUrl);
  registerSecret(password);
  if (password === undefined) return dbUrl;
  const at = url.indexOf("@");
  return `${url.slice(0, at)}:${encodeURIComponent(password)}${url.slice(at)}`;
}

/** Open a short-lived connection. */
export async function withClient<T>(
  dbUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: normalizeUrl(dbUrl),
    connectionTimeoutMillis: 10_000,
    application_name: "lintel",
  });
  // A dropped connection emits 'error' asynchronously; without a listener it would crash the process.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    throw mapPgError(err);
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export function mapPgError(err: unknown): LintelError {
  if (err instanceof LintelError) return err;
  const e = err as { code?: string; message?: string };
  const message = redact(e.message ?? String(err));
  switch (e.code) {
    case "28P01":
    case "28000":
      return new LintelError("LINTEL_E_AUTH", "the database rejected the credentials", {
        cause:
          "wrong password, or the wrong user for a pooler URL (it must be postgres.<project-ref>)",
        next: "copy the connection string again from the dashboard: Connect → Session pooler",
        details: message,
      });
    case "3D000":
      return new LintelError("LINTEL_E_CONNECT", "that database does not exist", {
        next: "check the database name at the end of the connection string (usually /postgres)",
        details: message,
      });
    case "ECONNREFUSED":
      return new LintelError(
        "LINTEL_E_CONNECT",
        "nothing is accepting connections at that host and port",
        {
          cause: "the local stack isn't running, or the port is wrong",
          next: "supabase status   (or: supabase start)",
          details: message,
        },
      );
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return new LintelError(
        "LINTEL_E_CONNECT",
        "the database host is unreachable from this network",
        {
          cause: "direct db.<ref>.supabase.co hosts are IPv6-only",
          next: "use the Session pooler connection string (IPv4) from the dashboard",
          details: message,
        },
      );
    case "ENOTFOUND":
      return new LintelError("LINTEL_E_CONNECT", "the database host name does not resolve", {
        next: "check the host in your connection string",
        details: message,
      });
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return new LintelError(
        "LINTEL_E_CONNECT",
        "the server's TLS certificate could not be verified",
        {
          cause: "sslmode=require verifies certificates in node-postgres",
          next: "download the CA from the dashboard and use sslmode=verify-full&sslrootcert=<path>",
          details: message,
        },
      );
    default:
      if (/timeout/i.test(message)) {
        return new LintelError("LINTEL_E_CONNECT", "connecting to the database timed out", {
          next: "check the host, port and any network restrictions on the project",
          details: message,
        });
      }
      return new LintelError("LINTEL_E_INTERNAL", message, {
        next: "please open an issue at https://github.com/Amsozzer1/lintel/issues",
      });
  }
}
