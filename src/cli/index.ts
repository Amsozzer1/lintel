import { Command, CommanderError } from "commander";
import { ExitCode } from "../core/errors.ts";
import { LINTEL_VERSION } from "../core/version.ts";
import { printError } from "./io.ts";

/** Every subcommand is imported lazily so `lintel --help` never loads pg, Docker or MCP code. */

let jsonErrors = false;

async function exec(fn: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (e) {
    process.exitCode = printError(e, jsonErrors).exitCode;
  }
}

const program = new Command()
  .name("lintel")
  .description(
    "Catch Supabase RLS leaks and schema problems in the pull request that introduces them.",
  )
  .version(LINTEL_VERSION, "-v, --version")
  .showHelpAfterError("(run lintel --help for usage)")
  .exitOverride()
  .hook("preAction", (_program, command) => {
    jsonErrors = command.opts().format === "json";
  });

program
  .command("check")
  .description("check one database (static findings from Supabase advisors)")
  .option("--db <url|env:VAR>", "database to check (default: env:DATABASE_URL)")
  .option("--format <format>", "human | json", "human")
  .option(
    "--fail-on <level>",
    "exit 1 on findings at or above: error | warn | info | none",
    "error",
  )
  .action((opts) => exec(async () => (await import("./commands/check.ts")).run(opts)));

const ciOptions = (cmd: Command, defaults: { baseRef?: string; format: string }) =>
  cmd
    .option("--base-ref <ref>", "git ref for the base (e.g. origin/main)", defaults.baseRef)
    .option("--head-ref <ref>", "git ref for the head (default: the working tree)")
    .option("--supabase-dir <path>", "Supabase directory relative to the repo root", "supabase")
    .option("--out-dir <dir>", "write base.json, head.json and diff.json here")
    .option("--format <format>", "human | json | markdown", defaults.format)
    .option(
      "--fail-on <level>",
      "exit 1 on NEW findings at or above: error | warn | info | none",
      "error",
    )
    .option(
      "--previous-comment <file>",
      "previous PR comment body, to report what was resolved since the last push",
    )
    .option("--no-pull", "fail instead of pulling the database image");

ciOptions(
  program
    .command("ci")
    .description(
      "replay base and head migrations into throwaway databases, check both, diff (for CI)",
    ),
  { format: "markdown" },
).action((opts) =>
  exec(async () => {
    if (!opts.baseRef) {
      const { LintelError } = await import("../core/errors.ts");
      throw new LintelError("LINTEL_E_USAGE", "--base-ref is required", {
        next: "lintel ci --base-ref origin/main --head-ref HEAD",
      });
    }
    return (await import("./commands/ci.ts")).run(opts);
  }),
);

const migrations = program
  .command("migrations")
  .description("work with your local Supabase migrations");
ciOptions(
  migrations
    .command("check")
    .description(
      "is this migration safe? diff your working tree against a base branch in throwaway databases",
    ),
  { baseRef: "main", format: "human" },
).action((opts) => exec(async () => (await import("./commands/ci.ts")).run(opts)));

program
  .command("diff")
  .description("diff two lintel.findings/v1 reports")
  .argument("<base.json>")
  .argument("<head.json>")
  .option("--format <format>", "human | json | markdown", "human")
  .option(
    "--fail-on <level>",
    "exit 1 on NEW findings at or above: error | warn | info | none",
    "error",
  )
  .option(
    "--previous-comment <file>",
    "previous PR comment body, to report what was resolved since the last push",
  )
  .action((base: string, head: string, opts) =>
    exec(async () => (await import("./commands/diff.ts")).run(base, head, opts)),
  );

program
  .command("setup")
  .description("one-time: download the database image so checks start in seconds")
  .action(() => exec(async () => (await import("./commands/setup.ts")).setup()));

program
  .command("doctor")
  .description("check Node, Docker, the database image and the Supabase CLI")
  .option("--cleanup", "remove containers left behind by interrupted runs")
  .action((opts) => exec(async () => (await import("./commands/setup.ts")).doctor(opts)));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void import("../core/replay/docker.ts")
      .then((d) => d.stopAll())
      .finally(() => process.exit(130));
  });
}

try {
  await program.parseAsync();
} catch (e) {
  if (e instanceof CommanderError) {
    const clean = ["commander.helpDisplayed", "commander.version", "commander.help"].includes(
      e.code,
    );
    process.exitCode = clean ? ExitCode.ok : ExitCode.usage;
  } else {
    process.exitCode = printError(e, jsonErrors).exitCode;
  }
}
