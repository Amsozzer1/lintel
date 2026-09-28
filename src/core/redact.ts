/**
 * Password redaction. Applied at every output sink (stdout, stderr, JSON, HTTP, MCP).
 *
 * Deliberately does not use a URL parser: real passwords contain unencoded `@ # / ?`,
 * which break parsers, and parser errors tend to echo the raw input.
 */

const MASK = "***";
const secrets = new Set<string>();

/**
 * Minimum length for masking a secret wherever it appears. Shorter strings are ordinary words
 * ("wrong", "admin"), and masking them would corrupt Lintel's own messages. Short passwords
 * are still masked by the structural rules (URL userinfo, password=, env assignments).
 */
const MIN_LITERAL_SECRET = 8;

/** Register a literal secret so it is masked wherever it appears, raw or percent-encoded. */
export function registerSecret(secret: string | undefined): void {
  if (!secret || secret.length < MIN_LITERAL_SECRET) return;
  secrets.add(secret);
  try {
    secrets.add(decodeURIComponent(secret));
  } catch {
    // not percent-encoded
  }
  secrets.add(encodeURIComponent(secret));
}

/** postgres://user:<anything up to the LAST @ in this token>@host */
const URL_USERINFO = /(postgres(?:ql)?:\/\/[^:@/\s]*:)(\S+)@(?=[^@\s]*(?:\s|$|["'`,)\]}]))/gi;
/** password=... in libpq key/value strings and query strings */
const KV_PASSWORD = /(\bpassword\s*=\s*)('[^']*'|[^\s&'"]+)/gi;
const ENV_PASSWORD = /(\b(?:PGPASSWORD|SUPABASE_DB_PASSWORD)\s*=\s*)(\S+)/g;

export function redact(text: string): string {
  let out = text.replace(URL_USERINFO, `$1${MASK}@`);
  out = out.replace(KV_PASSWORD, `$1${MASK}`);
  out = out.replace(ENV_PASSWORD, `$1${MASK}`);
  // Longest first so a secret that contains another is fully masked.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(MASK);
  }
  return out;
}

/** Split a connection string into a password-free URL and the password, without a URL parser. */
export function splitPassword(url: string): { url: string; password: string | undefined } {
  const match = /^(postgres(?:ql)?:\/\/[^:@/\s]*):(.*)@([^@]*)$/i.exec(url);
  if (!match) return { url, password: undefined };
  const [, head, rawPassword, rest] = match as unknown as [string, string, string, string];
  let password = rawPassword;
  try {
    password = decodeURIComponent(rawPassword);
  } catch {
    // unencoded password with a literal %
  }
  return { url: `${head}@${rest}`, password };
}
