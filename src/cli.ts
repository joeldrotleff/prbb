import { Command } from "commander";
import { GhClient } from "./gh.ts";
import { babysit } from "./babysit.ts";
import { parsePrInput } from "./core/ref.ts";
import { PrbbError } from "./util/errors.ts";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("prbb")
    .description(
      "Babysits one pull request: enables auto-merge, rebases when behind, " +
        "and errors on merge conflicts or anything else blocking the merge.",
    )
    .version("0.2.0")
    .argument("<pr>", "PR reference: org/123, owner/repo#123, or a full PR URL")
    .option("--interval <seconds>", "poll interval in seconds", "30")
    .action(async (input: string, options: { interval: string }) => {
      const baseMs = Number(options.interval) * 1000;
      await babysit(parsePrInput(input), {
        gh: new GhClient(),
        log: (line) => process.stdout.write(`[${new Date().toLocaleTimeString()}] ${line}\n`),
        backoff: { baseMs, maxMs: Math.max(baseMs * 10, 300_000) },
      });
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof PrbbError) {
      process.stderr.write(`error: ${error.message}\n`);
      process.exit(error.exitCode);
    }
    throw error;
  }
}
