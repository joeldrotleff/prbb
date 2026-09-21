import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { GhClient } from "./gh.ts";
import { Engine } from "./engine.ts";
import { loadConfig, saveConfig, addManualPr, removePr, configPath } from "./config.ts";
import { parsePrRef, prKey } from "./core/ref.ts";
import { statusJson, eventJsonl } from "./output.ts";
import { PrbbError, ExitCode } from "./util/errors.ts";
import { App } from "./tui/App.tsx";

interface CommonOptions {
  drafts?: boolean;
  watchOnly?: boolean;
  interval?: string;
}

function makeEngine(gh: GhClient, options: CommonOptions) {
  const config = loadConfig();
  const intervalMs = options.interval ? Number(options.interval) * 1000 : 30_000;
  const engine = new Engine(gh, config, {
    includeDrafts: options.drafts ?? false,
    watchOnly: options.watchOnly ?? false,
    backoff: { baseMs: intervalMs, maxMs: Math.max(intervalMs * 10, 300_000) },
  });
  return { engine, config };
}

async function resolveRefs(inputs: string[], repoFlag: string | undefined, gh: GhClient) {
  const needsContext = inputs.some((i) => /^#?\d+$/.test(i.trim()));
  const contextRepo =
    repoFlag ?? (needsContext ? ((await gh.currentRepo()) ?? undefined) : undefined);
  return inputs.map((input) => parsePrRef(input, contextRepo));
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  const gh = new GhClient();

  program
    .name("prbb")
    .description("Babysits your GitHub pull requests.")
    .version("0.1.0")
    .option("--drafts", "include draft PRs")
    .option("--watch-only", "watch and report, never write (no auto-merge or branch updates)")
    .option("--interval <seconds>", "poll interval in seconds", "30");

  // Default command: interactive TUI.
  program.action(async () => {
    const options = program.opts<CommonOptions>();
    const { engine, config } = makeEngine(gh, options);
    const { waitUntilExit } = render(
      React.createElement(App, { engine, gh, config, watchOnly: options.watchOnly ?? false }),
      { exitOnCtrlC: false },
    );
    await waitUntilExit();
    engine.stop();
  });

  program
    .command("status")
    .description("One snapshot of all tracked PRs (use --json for machine output)")
    .option("--json", "print JSON to stdout")
    .action(async (cmdOptions: { json?: boolean }) => {
      const options = program.opts<CommonOptions>();
      // Snapshot never writes to GitHub, whatever the global flags say.
      const { engine } = makeEngine(gh, { ...options, watchOnly: true });
      await engine.pollOnce();
      const prs = [...engine.prs.values()];
      const plans = await engine.planAll();
      if (cmdOptions.json) {
        process.stdout.write(statusJson(prs, plans) + "\n");
      } else {
        for (const pr of prs) {
          const plan = plans.find((p) => p.pr.key === pr.key);
          process.stdout.write(
            `${pr.key}  ${pr.state}${pr.isDraft ? "/draft" : ""}  checks:${pr.checks}  ` +
              `review:${pr.reviewDecision.toLowerCase()}  merge:${pr.mergeState.toLowerCase()}  ` +
              `auto:${pr.autoMergeEnabled ? "on" : "off"}  → ${plan?.reason ?? ""}\n`,
          );
        }
        if (prs.length === 0) process.stdout.write("No tracked PRs.\n");
      }
    });

  program
    .command("watch")
    .description("Poll continuously and emit one JSON event per line (JSONL) to stdout")
    .action(async () => {
      const options = program.opts<CommonOptions>();
      const { engine } = makeEngine(gh, options);
      engine.onEvent((event) => process.stdout.write(eventJsonl(event) + "\n"));
      const stop = () => {
        engine.stop();
        process.exit(ExitCode.ok);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await engine.runLoop();
    });

  program
    .command("add")
    .description("Track one or more PRs (URL, owner/repo#123, or number with --repo)")
    .argument("<refs...>", "PR references")
    .option("--repo <owner/name>", "repository for bare PR numbers")
    .action(async (inputs: string[], cmdOptions: { repo?: string }) => {
      const refs = await resolveRefs(inputs, cmdOptions.repo, gh);
      let config = loadConfig();
      for (const ref of refs) {
        await gh.viewPr(ref); // Validate the PR exists before persisting.
        config = addManualPr(config, ref);
        process.stderr.write(`Tracking ${prKey(ref)}\n`);
      }
      saveConfig(config);
    });

  program
    .command("remove")
    .description("Stop tracking a PR (also hides it from auto-discovery)")
    .argument("<refs...>", "PR references")
    .option("--repo <owner/name>", "repository for bare PR numbers")
    .action(async (inputs: string[], cmdOptions: { repo?: string }) => {
      const refs = await resolveRefs(inputs, cmdOptions.repo, gh);
      let config = loadConfig();
      for (const ref of refs) {
        config = removePr(config, ref);
        process.stderr.write(`Removed ${prKey(ref)}\n`);
      }
      saveConfig(config);
    });

  program
    .command("config-path")
    .description("Print the config file location")
    .action(() => {
      process.stdout.write(configPath() + "\n");
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof PrbbError) {
      process.stderr.write(
        JSON.stringify({ error: { code: error.code, message: error.message } }) + "\n",
      );
      process.exit(error.exitCode);
    }
    throw error;
  }
}
