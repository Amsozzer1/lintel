export const ExitCode = {
  ok: 0,
  findings: 1,
  usage: 2,
  connect: 3,
  internal: 4,
  migration: 5,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export const DOCS_BASE = "https://github.com/Amsozzer1/lintel/blob/main/docs";

interface ErrorSpec {
  exit: ExitCode;
  summary: string;
  /** What usually causes it and how to fix it. Rendered into docs/errors.md. */
  fix: string[];
}

/** Every error Lintel can raise. Codes are part of the public contract (CLI, REST, MCP). */
export const ERROR_CATALOG = {
  LINTEL_E_USAGE: {
    exit: ExitCode.usage,
    summary: "Invalid arguments or options.",
    fix: [
      "Check the command and flags with `lintel <command> --help`.",
      "Unknown rule: rule ids are probe ids (`P001`) or Supabase lint names or numbers (`rls_disabled_in_public`, `0013`). The MCP tool `list_checks` lists them all.",
      "Unknown profile: add it under `profiles` in `lintel.config.json`.",
      "Config file not found from an MCP client: pass an absolute path with `lintel mcp --config /abs/path/lintel.config.json`. MCP clients start servers from an unpredictable directory.",
    ],
  },
  LINTEL_E_NO_DATABASE: {
    exit: ExitCode.usage,
    summary: "No database was given.",
    fix: [
      "Pass `--db <url>`, or set `DATABASE_URL`.",
      "For a profile that reads `env:NAME`, set that variable in the environment that starts Lintel. For MCP, that is the `env` block of the server's client config.",
    ],
  },
  LINTEL_E_INPUT_FILE: {
    exit: ExitCode.usage,
    summary: "An input file is missing or not a valid Lintel report.",
    fix: [
      "`lintel diff` takes two files written by `lintel check --format json`.",
      "Check the paths, and that both files are `lintel.findings/v1` reports ([schema](../schemas/findings.v1.json)).",
    ],
  },
  LINTEL_E_CONNECT: {
    exit: ExitCode.connect,
    summary: "Could not connect to the database.",
    fix: [
      "Local Supabase: is it running? Try `supabase status`, then `supabase start`.",
      "Check the host, port and database name in the connection string.",
      "Hosted Supabase: use the connection string from the dashboard (Connect → Session pooler if your network has no IPv6).",
    ],
  },
  LINTEL_E_AUTH: {
    exit: ExitCode.connect,
    summary: "The database rejected the credentials.",
    fix: [
      "Check the user and password in the connection string. Lintel never prints the password, so compare against your source.",
      "Special characters in the password must be URL-encoded (`@` → `%40`, `#` → `%23`).",
    ],
  },
  LINTEL_E_SUPABASE_CLI: {
    exit: ExitCode.connect,
    summary: "The Supabase CLI is missing or failed.",
    fix: [
      "Install it: `brew install supabase/tap/supabase` or `npm i -g supabase`, then check `supabase --version`.",
      "Run `lintel doctor` to see what Lintel finds on your PATH.",
      "If `supabase db advisors` timed out, the database may be overloaded or unreachable. Retry, or run it directly to see its own error.",
    ],
  },
  LINTEL_E_DOCKER: {
    exit: ExitCode.connect,
    summary: "Docker is not available or a container failed to start.",
    fix: [
      "Start Docker Desktop (or the Docker daemon) and check `docker info`.",
      "Image not downloaded: run `lintel setup` once. Lintel does not pull images in the middle of a check.",
      "Container not ready in time: the machine may be low on memory. Close other containers and retry.",
    ],
  },
  LINTEL_E_GIT: {
    exit: ExitCode.usage,
    summary: "A git ref or path could not be read.",
    fix: [
      "Folder does not exist or is not a git repository: pass the repository root (the folder that contains `.git`). From MCP, `repo_dir` must be an absolute path.",
      "Ref not found: fetch it with `git fetch origin main`. In GitHub Actions, use `actions/checkout` with `fetch-depth: 0`; checkouts are shallow by default.",
    ],
  },
  LINTEL_E_MIGRATION: {
    exit: ExitCode.migration,
    summary: "A migration failed to apply.",
    fix: [
      "The error names the migration and includes Postgres's message. Reproduce it with `supabase db reset`.",
      "A migration that depends on data or extensions from outside the repo will fail on a fresh database. Put what it needs in an earlier migration or `seed.sql`.",
    ],
  },
  LINTEL_E_INTERNAL: {
    exit: ExitCode.internal,
    summary: "An unexpected error (a bug in Lintel).",
    fix: [
      "Please [open an issue](https://github.com/Amsozzer1/lintel/issues) with the command you ran and the output.",
    ],
  },
} as const satisfies Record<string, ErrorSpec>;
export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface LintelErrorInit {
  /** Most likely reason, in plain words. */
  cause?: string;
  /** The next command or action to try. */
  next?: string;
  details?: string;
}

export class LintelError extends Error {
  readonly code: ErrorCode;
  readonly likelyCause: string | undefined;
  readonly next: string | undefined;
  readonly details: string | undefined;

  constructor(code: ErrorCode, message: string, init: LintelErrorInit = {}) {
    super(message);
    this.name = "LintelError";
    this.code = code;
    this.likelyCause = init.cause;
    this.next = init.next;
    this.details = init.details;
  }

  get exitCode(): ExitCode {
    return ERROR_CATALOG[this.code].exit;
  }

  get docsUrl(): string {
    return `${DOCS_BASE}/errors.md#${this.code.toLowerCase()}`;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint:
        [this.likelyCause, this.next && `try: ${this.next}`].filter(Boolean).join(" — ") ||
        undefined,
      docs_url: this.docsUrl,
    };
  }
}

export function toLintelError(err: unknown): LintelError {
  if (err instanceof LintelError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LintelError("LINTEL_E_INTERNAL", message, {
    next: "please open an issue at https://github.com/Amsozzer1/lintel/issues with the command you ran",
  });
}

/** docs/errors.md, generated from ERROR_CATALOG so every docs_url anchor exists. */
export function errorsMarkdown(): string {
  const lines = [
    "# Errors",
    "",
    "<!-- Generated from src/core/errors.ts by `pnpm gen`. Do not edit by hand. -->",
    "",
    "Every Lintel error has a stable code. The CLI prints it with a hint and exits with the code below; the MCP server returns it as `{ error: { code, message, hint, docs_url } }` in a tool result with `isError: true`.",
    "",
    "| Code | Exit | Meaning |",
    "|---|---|---|",
    ...Object.entries(ERROR_CATALOG).map(
      ([code, e]) => `| [\`${code}\`](#${code.toLowerCase()}) | ${e.exit} | ${e.summary} |`,
    ),
  ];
  for (const [code, e] of Object.entries(ERROR_CATALOG)) {
    lines.push(
      "",
      `## ${code}`,
      "",
      `${e.summary} Exit code ${e.exit}.`,
      "",
      ...e.fix.map((f) => `- ${f}`),
    );
  }
  return `${lines.join("\n")}\n`;
}
