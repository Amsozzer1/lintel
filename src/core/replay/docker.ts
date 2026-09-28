/**
 * Throwaway Supabase Postgres containers. Everything Lintel starts is labelled
 * `lintel.managed=1`, removed on exit, and disposable by construction.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import { LintelError } from "../errors.ts";
import { redact, registerSecret } from "../redact.ts";

export const DEFAULT_IMAGE =
  "supabase/postgres:17.6.1.013@sha256:d4cb9da1a55b2ea7c64b9d60b14836432a6d01cced5cf1b9dd51f4ab51ff94db";
export const MANAGED_LABEL = "lintel.managed=1";

export interface ManagedDb {
  id: string;
  /** Connection string reachable from the host. */
  url: string;
  /** Run SQL through psql inside the container as `role`. Rejects with psql's stderr. */
  psql(sql: string, role?: "postgres" | "supabase_admin"): Promise<string>;
  stop(): Promise<void>;
}

const running = new Set<string>();

export interface StartOptions {
  image?: string;
  /** Pull the image if it is missing (can take minutes). MCP turns this off. */
  allowPull?: boolean;
  onProgress?: (message: string) => void;
}

export async function startDb(opts: StartOptions = {}): Promise<ManagedDb> {
  const image = opts.image ?? DEFAULT_IMAGE;
  await ensureImage(image, opts);
  const password = randomBytes(18).toString("base64url");
  registerSecret(password);

  // `-e NAME` without a value copies it from our environment, keeping the password out of argv.
  const run = await docker(
    [
      "run",
      "-d",
      "--rm",
      "--label",
      MANAGED_LABEL,
      "-e",
      "POSTGRES_PASSWORD",
      "-p",
      "127.0.0.1::5432",
      image,
    ],
    { POSTGRES_PASSWORD: password },
  );
  const id = run.trim();
  running.add(id);

  const stop = async () => {
    running.delete(id);
    await execa("docker", ["rm", "-f", id], { reject: false });
  };

  try {
    const port = (await docker(["port", id, "5432/tcp"])).trim().split("\n")[0]?.split(":").pop();
    if (!port)
      throw new LintelError("LINTEL_E_DOCKER", "could not read the container's mapped port");
    const psql = async (sql: string, role: "postgres" | "supabase_admin" = "postgres") => {
      const r = await execa(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          "PGPASSWORD",
          id,
          "psql",
          "-X",
          "-q",
          "-A",
          "-t",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          role,
          "-h",
          "127.0.0.1",
          "-d",
          "postgres",
        ],
        { input: sql, env: { PGPASSWORD: password }, reject: false },
      );
      if (r.exitCode !== 0) throw new Error(redact(String(r.stderr || r.stdout)));
      return String(r.stdout);
    };
    await waitReady(psql);
    await bootstrap(psql);
    return {
      id,
      url: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
      psql,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Stop every container this process started (signal handlers call this). */
export async function stopAll(): Promise<void> {
  await Promise.all([...running].map((id) => execa("docker", ["rm", "-f", id], { reject: false })));
  running.clear();
}

/** Remove leftover containers from crashed runs. */
export async function cleanupManaged(): Promise<number> {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${MANAGED_LABEL}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
  return ids.length;
}

export async function pullImage(image = DEFAULT_IMAGE): Promise<void> {
  await docker(["pull", image]);
}

async function ensureImage(image: string, opts: StartOptions): Promise<void> {
  const inspect = await execa("docker", ["image", "inspect", image], { reject: false });
  if (inspect.failed && inspect.exitCode === undefined) throw dockerMissing(inspect.message);
  if (inspect.exitCode === 0) return;
  if (/Cannot connect to the Docker daemon|error during connect/i.test(String(inspect.stderr))) {
    throw dockerMissing(inspect.stderr);
  }
  if (opts.allowPull === false) {
    throw new LintelError("LINTEL_E_DOCKER", "the Supabase Postgres image is not downloaded yet", {
      cause: "first run on this machine (the image is about 800 MB)",
      next: "lintel setup",
    });
  }
  opts.onProgress?.("pulling the Supabase Postgres image (one time, about 800 MB)…");
  await pullImage(image);
}

/**
 * Supabase's init scripts restart the server partway through, so `pg_isready` passes too early.
 * Ready means: the `authenticated` role exists and the postmaster start time is stable.
 */
async function waitReady(psql: ManagedDb["psql"], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStart = "";
  while (Date.now() < deadline) {
    const out = await psql(
      "select pg_postmaster_start_time()::text from pg_roles where rolname = 'authenticated'",
    ).catch(() => "");
    const start = out.trim();
    if (start && start === lastStart) return;
    lastStart = start;
    await sleep(start ? 1500 : 500);
  }
  throw new LintelError("LINTEL_E_DOCKER", "the database container did not become ready in time", {
    next: "docker ps --filter label=lintel.managed=1   (then: lintel doctor --cleanup)",
  });
}

/** The image predates `auth.jwt()` (it ships with the auth server). Stub it when missing so policies that call it apply. */
async function bootstrap(psql: ManagedDb["psql"]): Promise<void> {
  await psql(
    `do $$ begin
       if to_regprocedure('auth.jwt()') is null then
         create function auth.jwt() returns jsonb language sql stable as
         $f$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                             nullif(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
         grant execute on function auth.jwt() to anon, authenticated, service_role;
       end if;
     end $$;`,
    "supabase_admin",
  );
}

async function docker(args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await execa("docker", args, { env, reject: false });
  if (r.failed && r.exitCode === undefined) throw dockerMissing(r.message);
  if (r.exitCode !== 0) {
    const stderr = String(r.stderr);
    if (/Cannot connect to the Docker daemon|error during connect|ENOENT/i.test(stderr))
      throw dockerMissing(stderr);
    throw new LintelError("LINTEL_E_DOCKER", `docker ${args[0]} failed`, {
      details: redact(stderr),
    });
  }
  return String(r.stdout);
}

function dockerMissing(err: unknown): LintelError {
  return new LintelError("LINTEL_E_DOCKER", "Docker is not available", {
    cause: "Docker isn't installed or the daemon isn't running",
    next: "start Docker Desktop, then: docker info",
    details: redact(err instanceof Error ? err.message : String(err)),
  });
}
