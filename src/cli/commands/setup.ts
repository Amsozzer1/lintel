import { execa } from "execa";
import { ExitCode, LintelError } from "../../core/errors.ts";
import { cleanupManaged, DEFAULT_IMAGE, pullImage } from "../../core/replay/docker.ts";
import { err, out } from "../io.ts";

/** One-time setup: pull the database image so later runs (and MCP calls) are fast. */
export async function setup(): Promise<number> {
  await requireSupabaseCli();
  err(`pulling ${DEFAULT_IMAGE.split("@")[0]} (about 800 MB, one time)…`);
  await pullImage();
  out("ready: lintel migrations check will now start in seconds");
  return ExitCode.ok;
}

export async function doctor(opts: { cleanup?: boolean }): Promise<number> {
  const rows: Array<[string, boolean, string]> = [];
  rows.push([
    "node >= 22",
    Number(process.versions.node.split(".")[0]) >= 22,
    process.versions.node,
  ]);
  const dockerInfo = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
    reject: false,
  }).catch(() => undefined);
  rows.push([
    "docker daemon",
    dockerInfo?.exitCode === 0,
    String(dockerInfo?.stdout ?? "not running"),
  ]);
  const image = await execa("docker", ["image", "inspect", DEFAULT_IMAGE], { reject: false }).catch(
    () => undefined,
  );
  rows.push([
    "database image",
    image?.exitCode === 0,
    image?.exitCode === 0 ? "present" : "missing: run lintel setup",
  ]);
  const cli = await execa("supabase", ["--version"], { reject: false }).catch(() => undefined);
  rows.push([
    "supabase CLI",
    cli?.exitCode === 0,
    String(cli?.stdout ?? "missing: brew install supabase/tap/supabase"),
  ]);
  for (const [name, ok, detail] of rows) out(`${ok ? "✓" : "✗"} ${name.padEnd(16)} ${detail}`);
  if (opts.cleanup) out(`removed ${await cleanupManaged()} leftover lintel container(s)`);
  return rows.every(([, ok]) => ok) ? ExitCode.ok : ExitCode.connect;
}

async function requireSupabaseCli(): Promise<void> {
  const r = await execa("supabase", ["--version"], { reject: false }).catch(() => undefined);
  if (r?.exitCode !== 0) {
    throw new LintelError("LINTEL_E_SUPABASE_CLI", "the Supabase CLI is not installed", {
      next: "brew install supabase/tap/supabase   (or: npm i -g supabase)",
    });
  }
}
