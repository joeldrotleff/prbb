import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import type { CommandRunner } from "./util/process.ts";
import { runCommand } from "./util/process.ts";
import { fail } from "./util/errors.ts";
import type { PrStatus } from "./core/model.ts";
import { prUrl } from "./core/ref.ts";

export interface ConflictAgentDeps {
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  repoPaths?: Record<string, string>;
}

export interface ConflictAgentResult {
  status: "started" | "already-running";
  workspaceLabel: string;
  worktreePath?: string;
}

function workspaceLabel(pr: PrStatus): string {
  return `🫡 Resolve conflict — ${pr.ref.repo}#${pr.ref.number}`;
}

function localRepoPath(
  pr: PrStatus,
  repoPaths: Record<string, string>,
  env: Record<string, string | undefined>,
): string {
  const configured = repoPaths[`${pr.ref.owner}/${pr.ref.repo}`];
  if (configured && existsSync(configured)) return configured;
  const guess = join(env.HOME ?? homedir(), "code", pr.ref.repo);
  if (existsSync(guess)) return guess;
  fail(
    `No local checkout found for ${pr.ref.owner}/${pr.ref.repo}. ` +
      `Add it to repoPaths in the prbb config.`,
    "conflictNeedsHerdr",
  );
}

// Starts (or finds) a Herdr shipmate to resolve a PR's merge conflict.
// Requires HERDR_ENV=1; outside Herdr this fails with instructions instead.
export async function startConflictAgent(
  pr: PrStatus,
  deps: ConflictAgentDeps = {},
): Promise<ConflictAgentResult> {
  const run = deps.run ?? runCommand;
  const env = deps.env ?? process.env;
  if (env.HERDR_ENV !== "1") {
    fail(
      `PR ${pr.key} has a merge conflict (${pr.headRefName} vs ${pr.baseRefName}).\n` +
        `Conflict resolution needs a Herdr agent. Rerun prbb inside a Herdr pane (HERDR_ENV=1), ` +
        `or resolve manually: ${pr.url}`,
      "conflictNeedsHerdr",
    );
  }

  const label = workspaceLabel(pr);

  // Reuse an existing conflict workspace for this PR instead of creating a duplicate.
  const snapshot = await run("herdr", ["api", "snapshot"]);
  if (snapshot.code === 0 && snapshot.stdout.includes(label)) {
    return { status: "already-running", workspaceLabel: label };
  }

  const repoPath = localRepoPath(pr, deps.repoPaths ?? {}, env);
  const wt = await run("wt", ["switch", pr.headRefName, "--format", "json", "--no-cd"], {
    cwd: repoPath,
  });
  if (wt.code !== 0) {
    fail(`wt switch ${pr.headRefName} failed: ${(wt.stderr || wt.stdout).trim()}`);
  }
  const worktreePath: string = JSON.parse(wt.stdout).path;

  const created = await run("herdr", [
    "workspace",
    "create",
    "--cwd",
    worktreePath,
    "--label",
    label,
    "--no-focus",
  ]);
  if (created.code !== 0) {
    fail(`herdr workspace create failed: ${(created.stderr || created.stdout).trim()}`);
  }
  const paneId: string = JSON.parse(created.stdout).result.root_pane.pane_id;

  const kickoffPath = join(tmpdir(), `prbb-conflict-${pr.ref.repo}-${pr.ref.number}.md`);
  writeFileSync(
    kickoffPath,
    `You are a shipmate in the fleet. Read \`~/.pi/agent/skills/herdr-fleet-mode/SKILL.md\` and follow its shipmate instructions.\n\n` +
      `Your task: Resolve the merge conflict on ${prUrl(pr.ref)} (branch \`${pr.headRefName}\` vs base \`${pr.baseRefName}\`). ` +
      `Update the branch, resolve conflicts faithfully to both sides' intent, run the project's checks, and push. ` +
      `Do not merge the PR or change unrelated code.\n\n` +
      `Checkout/branch: ${worktreePath} on ${pr.headRefName}\n` +
      `Own this task directly with the user.\n`,
  );

  const started = await run("herdr", [
    "agent",
    "start",
    `conflict-${pr.ref.repo}-${pr.ref.number}`,
    "--kind",
    "pi",
    "--pane",
    paneId,
    "--timeout",
    "5000",
    "--",
    "--name",
    label,
    `@${kickoffPath}`,
  ]);
  // A timeout can mean the kickoff already put Pi to work; the workspace exists either way.
  if (started.code !== 0 && !/timeout/i.test(started.stderr)) {
    fail(`herdr agent start failed: ${(started.stderr || started.stdout).trim()}`);
  }
  await run("herdr", ["pane", "rename", paneId, label]);

  return { status: "started", workspaceLabel: label, worktreePath };
}
