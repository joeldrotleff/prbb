import { GhClient } from "./gh.ts";
import type { PrRef, PrInput } from "./core/ref.ts";
import { prKey } from "./core/ref.ts";
import type { PrStatus } from "./core/model.ts";
import { mapPrStatus } from "./core/model.ts";
import { fail } from "./util/errors.ts";
import { nextPollDelay, type BackoffOptions } from "./core/backoff.ts";

export interface BabysitDeps {
  gh: GhClient;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  backoff?: BackoffOptions;
  // Minimum time between branch updates so GitHub can recalculate in between.
  updateCooldownMs?: number;
  now?: () => number;
}

// Prefer rebase; fall back to what the repository allows.
export function pickMergeMethod(methods: {
  rebase: boolean;
  squash: boolean;
  merge: boolean;
}): "rebase" | "squash" | "merge" | null {
  if (methods.rebase) return "rebase";
  if (methods.squash) return "squash";
  if (methods.merge) return "merge";
  return null;
}

// The `org/123` form has no repo; find it among the user's open PRs in that org.
export async function resolveRef(input: PrInput, gh: GhClient): Promise<PrRef> {
  if (input.repo) return input;
  const user = await gh.currentUser();
  const candidates = (await gh.searchAuthoredPrs(user, true, input.owner)).filter(
    (ref) => ref.number === input.number,
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    fail(
      `No open PR #${input.number} authored by ${user} found in ${input.owner}. ` +
        `Use owner/repo#${input.number} or a full URL.`,
      "usage",
    );
  }
  fail(
    `PR number ${input.number} is ambiguous in ${input.owner}: ` +
      candidates.map(prKey).join(", ") +
      ". Use owner/repo#number.",
    "usage",
  );
}

// Show at most a few check names so the line stays one line.
function nameList(names: string[], max = 4): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown}, +${names.length - max} more` : shown;
}

function summary(pr: PrStatus): string {
  return (
    `🩺 checks:${pr.checks}` +
    (pr.checksFailed > 0 ? ` (failing: ${nameList(pr.failedChecks)})` : "") +
    (pr.checksPending > 0 ? ` (running: ${nameList(pr.runningChecks)})` : "") +
    `  review:${pr.reviewDecision.toLowerCase()}  merge:${pr.mergeState.toLowerCase()}` +
    `  auto-merge:${pr.autoMergeEnabled ? "on" : "off"}`
  );
}

// Watches one PR until it merges: enables auto-merge, rebases the branch when it
// falls behind, and fails loudly on anything auto-merge cannot get past.
export async function babysit(input: PrInput, deps: BabysitDeps): Promise<void> {
  const { gh, log } = deps;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const updateCooldownMs = deps.updateCooldownMs ?? 120_000;

  const ref = await resolveRef(input, gh);
  log(`👶 babysitting ${prKey(ref)}`);

  let lastSummary = "";
  let lastUpdateAt = -Infinity;
  let failures = 0;

  while (true) {
    let pr: PrStatus;
    try {
      pr = mapPrStatus(ref, await gh.viewPr(ref), "manual");
      failures = 0;
    } catch (error) {
      failures += 1;
      log(`😭 poll failed (${error instanceof Error ? error.message.split("\n")[0] : error})`);
      await sleep(nextPollDelay(failures, deps.backoff));
      continue;
    }

    if (pr.state === "MERGED") {
      log(`🎉 ${prKey(ref)} merged — baby's all grown up 🧸`);
      return;
    }
    if (pr.state === "CLOSED") fail(`${prKey(ref)} was closed without merging.`, "prClosed");
    if (pr.isDraft) fail(`${prKey(ref)} is a draft; mark it ready first.`, "blocked");
    if (pr.mergeable === "CONFLICTING") {
      fail(
        `${prKey(ref)} has a merge conflict (${pr.headRefName} vs ${pr.baseRefName}). ` +
          `Resolve it, then rerun prbb. ${pr.url}`,
        "conflictNeedsHerdr",
      );
    }
    if (pr.checks === "failing") {
      fail(
        `${prKey(ref)} has failing check(s): ${nameList(pr.failedChecks, 10)}. ${pr.url}`,
        "blocked",
      );
    }
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      fail(`${prKey(ref)} has changes requested; address the review first. ${pr.url}`, "blocked");
    }

    const line = summary(pr);
    if (line !== lastSummary) {
      log(line);
      lastSummary = line;
    }

    if (!pr.autoMergeEnabled) {
      const method = pickMergeMethod(await gh.repoMergeMethods(ref.owner, ref.repo));
      if (!method) fail(`${prKey(ref)}: repository allows no merge method.`, "blocked");
      await gh.enableAutoMerge(ref, method);
      log(`🍼 enabled auto-merge (${method})`);
    }

    if (pr.mergeState === "BEHIND" && now() - lastUpdateAt >= updateCooldownMs) {
      log(`🚼 branch is behind ${pr.baseRefName}; rebasing via gh`);
      await gh.updateBranch(ref, { rebase: true });
      lastUpdateAt = now();
    }

    await sleep(nextPollDelay(0, deps.backoff));
  }
}
