/**
 * A replay database with no way out. Migrations in the wild call pg_net, http and dblink, often
 * with a live project's URL and key written into the SQL; replaying them must never reach it.
 *
 * The database sits on a Docker `--internal` network (no route outside). A second container from
 * the same image, on that network and the default bridge, forwards 127.0.0.1:<port> on the host to
 * the database's 5432 and does nothing else.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { execa } from "execa";
import { registerSecret } from "../src/core/redact.ts";
import { DEFAULT_IMAGE, MANAGED_LABEL, type ManagedDb } from "../src/core/replay/docker.ts";
import { CONTAINER_SETUP_SQL } from "../src/core/supabase/environment.ts";

export const NETWORK = "lintel-study-internal";

const FORWARDER = `
import asyncio, sys
target = sys.argv[1]
async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()
async def handle(client_reader, client_writer):
    server_reader, server_writer = await asyncio.open_connection(target, 5432)
    await asyncio.gather(pipe(client_reader, server_writer), pipe(server_reader, client_writer))
async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", 5432)
    async with server:
        await server.serve_forever()
asyncio.run(main())
`;

const docker = async (args: string[], env: Record<string, string> = {}) =>
  (await execa("docker", args, { env })).stdout.trim();

async function ensureNetwork(): Promise<void> {
  const exists = await execa("docker", ["network", "inspect", NETWORK], { reject: false });
  if (exists.exitCode === 0) {
    const internal = await docker(["network", "inspect", NETWORK, "--format", "{{.Internal}}"]);
    if (internal !== "true") throw new Error(`${NETWORK} exists but is not --internal`);
    return;
  }
  await docker(["network", "create", "--internal", "--label", MANAGED_LABEL, NETWORK]);
}

export async function startIsolatedDb(): Promise<ManagedDb & { container: string }> {
  await ensureNetwork();
  const tag = randomBytes(4).toString("hex");
  const dbName = `lintel-study-db-${tag}`;
  const fwdName = `lintel-study-fwd-${tag}`;
  const password = randomBytes(18).toString("base64url");
  registerSecret(password);

  const containers: string[] = [];
  const stop = async () => {
    await execa("docker", ["rm", "-f", ...containers], { reject: false });
  };
  try {
    containers.push(
      await docker(
        [
          "run",
          "-d",
          "--rm",
          "--label",
          MANAGED_LABEL,
          "--name",
          dbName,
          "--network",
          NETWORK,
        ].concat(["-e", "POSTGRES_PASSWORD", DEFAULT_IMAGE]),
        { POSTGRES_PASSWORD: password },
      ),
    );
    containers.push(
      await docker([
        "run",
        "-d",
        "--rm",
        "--label",
        MANAGED_LABEL,
        "--name",
        fwdName,
        "-p",
        "127.0.0.1::5432",
        "--entrypoint",
        "python3",
        DEFAULT_IMAGE,
        "-c",
        FORWARDER,
        dbName,
      ]),
    );
    await docker(["network", "connect", NETWORK, fwdName]);
    const port = (await docker(["port", fwdName, "5432/tcp"])).split("\n")[0]?.split(":").pop();
    if (!port) throw new Error("could not read the forwarder's port");

    const psql = async (sql: string, role: "postgres" | "supabase_admin" = "postgres") => {
      const r = await execa(
        "docker",
        [
          "exec",
          "-i",
          "-e",
          "PGPASSWORD",
          dbName,
          "psql",
          "-X",
          "-q",
          "-A",
          "-t",
          "-v",
          "ON_ERROR_STOP=1",
        ].concat(["-U", role, "-h", "127.0.0.1", "-d", "postgres"]),
        { input: sql, env: { PGPASSWORD: password }, reject: false },
      );
      if (r.exitCode !== 0) throw new Error(String(r.stderr || r.stdout));
      return String(r.stdout);
    };

    // Same readiness rule as src/core/replay/docker.ts: the init scripts restart the server.
    let last = "";
    for (let i = 0; ; i++) {
      if (i > 240) throw new Error("the database did not become ready");
      const start = (
        await psql(
          "select pg_postmaster_start_time()::text from pg_roles where rolname = 'authenticated'",
        ).catch(() => "")
      ).trim();
      if (start && start === last) break;
      last = start;
      await sleep(start ? 1500 : 500);
    }
    await psql(CONTAINER_SETUP_SQL, "supabase_admin");

    return {
      id: containers[0] as string,
      container: dbName,
      url: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
      psql,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Prove the database can't reach the internet: a direct connection and a DNS lookup must fail. */
export async function assertIsolated(container: string): Promise<string> {
  const probe = `
import socket
results = []
for host, port in [("1.1.1.1", 443), ("8.8.8.8", 53)]:
    try:
        socket.create_connection((host, port), timeout=3).close(); results.append(f"{host}:{port} REACHABLE")
    except OSError as e:
        results.append(f"{host}:{port} blocked ({e.__class__.__name__})")
try:
    socket.getaddrinfo("supabase.co", 443); results.append("dns REACHABLE")
except OSError as e:
    results.append(f"dns blocked ({e.__class__.__name__})")
print("; ".join(results))
`;
  const out = await docker(["exec", container, "python3", "-c", probe]);
  if (out.includes("REACHABLE")) throw new Error(`replay container is not isolated: ${out}`);
  return out;
}
