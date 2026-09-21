import type { CommandRunner } from "./util/process.ts";
import { runCommand, commandString } from "./util/process.ts";
import { fail, PrbbError } from "./util/errors.ts";
import type { PrRef } from "./core/ref.ts";
import type { GhPrJson } from "./core/model.ts";
import { prStatusJsonFields } from "./core/model.ts";
import type { MergeMethods } from "./core/plan.ts";

// Small typed adapter around the installed `gh` CLI. All GitHub reads and writes
// go through here so tests can inject a fake runner and never touch real PRs.
export class GhClient {
  constructor(private readonly run: CommandRunner = runCommand) {}

  private async gh(args: string[], options: { check?: boolean } = {}): Promise<string> {
    const result = await this.run("gh", args, { env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
    if (result.code !== 0 && options.check !== false) {
      const detail = (result.stderr || result.stdout).trim();
      if (/gh auth login|not logged in|authentication|HTTP 401/i.test(detail)) {
        fail(`GitHub authentication failed. Run \`gh auth login\`.\n${detail}`, "authFailure");
      }
      throw new PrbbError(`gh failed (${result.code}): ${commandString("gh", args)}\n${detail}`);
    }
    return result.stdout;
  }

  async currentUser(): Promise<string> {
    const out = await this.gh(["api", "user", "--jq", ".login"]);
    const login = out.trim();
    if (!login) fail("Could not determine the active gh user.", "authFailure");
    return login;
  }

  // Finds open PRs authored by the user across all repositories.
  async searchAuthoredPrs(user: string, includeDrafts: boolean): Promise<PrRef[]> {
    const args = [
      "search",
      "prs",
      "--author",
      user,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,repository,isDraft",
    ];
    if (!includeDrafts) args.push("--", "draft:false");
    const rows: Array<{ number: number; repository: { nameWithOwner: string } }> = JSON.parse(
      await this.gh(args),
    );
    return rows.map((row) => {
      const [owner, repo] = row.repository.nameWithOwner.split("/");
      return { owner: owner!, repo: repo!, number: row.number };
    });
  }

  async viewPr(ref: PrRef): Promise<GhPrJson> {
    const out = await this.gh([
      "pr",
      "view",
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--json",
      prStatusJsonFields,
    ]);
    return JSON.parse(out);
  }

  async repoMergeMethods(owner: string, repo: string): Promise<MergeMethods> {
    const out = await this.gh([
      "api",
      `repos/${owner}/${repo}`,
      "--jq",
      "{rebase: .allow_rebase_merge, squash: .allow_squash_merge, merge: .allow_merge_commit}",
    ]);
    return JSON.parse(out);
  }

  async enableAutoMerge(ref: PrRef, method: "rebase" | "squash" | "merge"): Promise<void> {
    await this.gh([
      "pr",
      "merge",
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--auto",
      `--${method}`,
    ]);
  }

  // Merge-commit update from base; never a force push to the PR branch.
  async updateBranch(ref: PrRef): Promise<void> {
    try {
      await this.gh([
        "pr",
        "update-branch",
        String(ref.number),
        "--repo",
        `${ref.owner}/${ref.repo}`,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PrbbError(
        `Branch update failed for #${ref.number}: ${message}`,
        "branchUpdateFailed",
      );
    }
  }

  // Repository name with owner + default branch of the current directory's repo, if any.
  async currentRepo(): Promise<string | null> {
    const result = await this.run("gh", [
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]);
    if (result.code !== 0) return null;
    const name = result.stdout.trim();
    return name.length > 0 ? name : null;
  }

  async openInBrowser(ref: PrRef): Promise<void> {
    await this.gh([
      "pr",
      "view",
      String(ref.number),
      "--repo",
      `${ref.owner}/${ref.repo}`,
      "--web",
    ]);
  }
}
