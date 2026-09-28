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
}

/** Every error Lintel can raise. Codes are part of the public contract (CLI, REST, MCP). */
export const ERROR_CATALOG = {
  LINTEL_E_USAGE: { exit: ExitCode.usage, summary: "Invalid arguments or options." },
  LINTEL_E_NO_DATABASE: { exit: ExitCode.usage, summary: "No database was given." },
  LINTEL_E_INPUT_FILE: {
    exit: ExitCode.usage,
    summary: "An input file is missing or not a valid Lintel report.",
  },
  LINTEL_E_CONNECT: { exit: ExitCode.connect, summary: "Could not connect to the database." },
  LINTEL_E_AUTH: { exit: ExitCode.connect, summary: "The database rejected the credentials." },
  LINTEL_E_SUPABASE_CLI: {
    exit: ExitCode.connect,
    summary: "The Supabase CLI is missing or failed.",
  },
  LINTEL_E_DOCKER: {
    exit: ExitCode.connect,
    summary: "Docker is not available or a container failed to start.",
  },
  LINTEL_E_GIT: { exit: ExitCode.usage, summary: "A git ref or path could not be read." },
  LINTEL_E_MIGRATION: { exit: ExitCode.migration, summary: "A migration failed to apply." },
  LINTEL_E_INTERNAL: { exit: ExitCode.internal, summary: "An unexpected error (a bug in Lintel)." },
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
