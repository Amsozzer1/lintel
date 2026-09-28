/**
 * lintel.config.json: named database profiles, so tools (MCP, REST) take a profile name
 * and connection strings never pass through an agent's context or a request body.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { LintelError } from "./errors.ts";

export const Config = z
  .object({
    schemas: z.array(z.string()).default(["public"]),
    profiles: z
      .record(
        z.string(),
        z.object({
          url: z.string().meta({
            description:
              "A connection string, or env:NAME to read it from the environment (recommended).",
          }),
        }),
      )
      .default({}),
  })
  .meta({ id: "LintelConfig" });
export type Config = z.infer<typeof Config>;

export async function loadConfig(path: string | undefined): Promise<Config> {
  if (!path) return Config.parse({});
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new LintelError("LINTEL_E_USAGE", `cannot read config file ${path}`, {
      cause: "MCP clients start servers from an unpredictable directory",
      next: "pass an absolute path: lintel mcp --config /abs/path/lintel.config.json",
    });
  }
  const parsed = Config.safeParse(safeJson(text));
  if (!parsed.success) {
    throw new LintelError("LINTEL_E_USAGE", `${path} is not a valid Lintel config`, {
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
    });
  }
  return parsed.data;
}

/** Resolve a profile to a connection string. With no config, `default` means $DATABASE_URL. */
export function resolveProfile(config: Config, name: string): string {
  const profile =
    config.profiles[name] ?? (name === "default" ? { url: "env:DATABASE_URL" } : undefined);
  if (!profile) {
    const known = Object.keys(config.profiles);
    throw new LintelError("LINTEL_E_USAGE", `unknown profile \`${name}\``, {
      next: known.length
        ? `use one of: ${known.join(", ")}`
        : 'add it under "profiles" in lintel.config.json',
    });
  }
  if (profile.url.startsWith("env:")) {
    const env = profile.url.slice(4);
    const url = process.env[env];
    if (!url) {
      throw new LintelError(
        "LINTEL_E_NO_DATABASE",
        `profile \`${name}\` reads $${env}, which is not set`,
        {
          next: `set ${env} in the environment that starts the server`,
        },
      );
    }
    return url;
  }
  return profile.url;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
