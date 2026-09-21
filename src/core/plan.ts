import type { PrStatus } from "./model.ts";

export type ActionKind = "enableAutoMerge" | "updateBranch" | "promptConflict" | "none";

export interface PlannedAction {
  kind: ActionKind;
  pr: PrStatus;
  reason: string;
}

export interface PlanContext {
  // Merge methods the repository allows, used to pick the auto-merge method.
  allowedMergeMethods: MergeMethods | null;
  // Keys of PRs recently acted on, still inside the action cooldown.
  cooldownKeys: Set<string>;
}

export interface MergeMethods {
  rebase: boolean;
  squash: boolean;
  merge: boolean;
}

// Rebase keeps history linear, so prefer it; fall back to what the repo allows.
export function pickMergeMethod(methods: MergeMethods): "rebase" | "squash" | "merge" | null {
  if (methods.rebase) return "rebase";
  if (methods.squash) return "squash";
  if (methods.merge) return "merge";
  return null;
}

// A PR is a stack layer when its base branch is the head branch of another tracked
// PR in the same repository. Stack layers must merge bottom-up, so prbb never
// auto-merges them and instead reports the required order.
export function findStackParents(prs: PrStatus[]): Map<string, PrStatus> {
  const byRepoHead = new Map<string, PrStatus>();
  for (const pr of prs) {
    byRepoHead.set(`${pr.ref.owner}/${pr.ref.repo}:${pr.headRefName}`, pr);
  }
  const parents = new Map<string, PrStatus>();
  for (const pr of prs) {
    const parent = byRepoHead.get(`${pr.ref.owner}/${pr.ref.repo}:${pr.baseRefName}`);
    if (parent && parent.key !== pr.key) parents.set(pr.key, parent);
  }
  return parents;
}

// Pure decision logic: given a PR's status, what single action should prbb take next?
export function planAction(
  pr: PrStatus,
  context: PlanContext,
  stackParent?: PrStatus,
): PlannedAction {
  if (pr.state !== "OPEN") return { kind: "none", pr, reason: `PR is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { kind: "none", pr, reason: "draft" };

  if (pr.mergeable === "CONFLICTING") {
    return { kind: "promptConflict", pr, reason: "merge conflict with base branch" };
  }

  if (stackParent) {
    return {
      kind: "none",
      pr,
      reason: `stacked on ${stackParent.key} (${stackParent.headRefName}); merge that first`,
    };
  }

  if (context.cooldownKeys.has(pr.key)) {
    return { kind: "none", pr, reason: "waiting out action cooldown" };
  }

  if (pr.mergeState === "BEHIND") {
    return { kind: "updateBranch", pr, reason: "behind base branch" };
  }

  if (pr.checks === "failing") return { kind: "none", pr, reason: "checks failing" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { kind: "none", pr, reason: "changes requested" };
  }

  if (!pr.autoMergeEnabled && pr.mergeState !== "UNKNOWN" && pr.mergeState !== "DIRTY") {
    const method = context.allowedMergeMethods
      ? pickMergeMethod(context.allowedMergeMethods)
      : null;
    if (!method) return { kind: "none", pr, reason: "repository allows no merge method" };
    return { kind: "enableAutoMerge", pr, reason: `auto-merge off; will enable (${method})` };
  }

  return { kind: "none", pr, reason: pr.autoMergeEnabled ? "auto-merge armed" : "waiting" };
}
