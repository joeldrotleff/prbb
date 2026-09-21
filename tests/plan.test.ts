import { describe, expect, test } from "bun:test";
import { planAction, pickMergeMethod, findStackParents } from "../src/core/plan.ts";
import type { PlanContext } from "../src/core/plan.ts";
import { prStatus } from "./fakes.ts";

const allMethods = { rebase: true, squash: true, merge: true };

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return { allowedMergeMethods: allMethods, cooldownKeys: new Set(), ...overrides };
}

describe("pickMergeMethod", () => {
  test("prefers rebase, then squash, then merge", () => {
    expect(pickMergeMethod(allMethods)).toBe("rebase");
    expect(pickMergeMethod({ rebase: false, squash: true, merge: true })).toBe("squash");
    expect(pickMergeMethod({ rebase: false, squash: false, merge: true })).toBe("merge");
    expect(pickMergeMethod({ rebase: false, squash: false, merge: false })).toBeNull();
  });
});

describe("planAction", () => {
  test("clean approved PR without auto-merge gets enableAutoMerge", () => {
    const plan = planAction(prStatus(), context());
    expect(plan.kind).toBe("enableAutoMerge");
  });

  test("PR behind base gets updateBranch", () => {
    const plan = planAction(prStatus({ mergeStateStatus: "BEHIND" }), context());
    expect(plan.kind).toBe("updateBranch");
  });

  test("conflicting PR prompts for Herdr", () => {
    const plan = planAction(prStatus({ mergeable: "CONFLICTING" }), context());
    expect(plan.kind).toBe("promptConflict");
  });

  test("drafts, merged, and closed PRs get no action", () => {
    expect(planAction(prStatus({ isDraft: true }), context()).kind).toBe("none");
    expect(planAction(prStatus({ state: "MERGED" }), context()).kind).toBe("none");
    expect(planAction(prStatus({ state: "CLOSED" }), context()).kind).toBe("none");
  });

  test("failing checks or requested changes block auto-merge", () => {
    expect(
      planAction(
        prStatus({ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }),
        context(),
      ).kind,
    ).toBe("none");
    expect(planAction(prStatus({ reviewDecision: "CHANGES_REQUESTED" }), context()).kind).toBe(
      "none",
    );
  });

  test("cooldown suppresses repeat actions", () => {
    const pr = prStatus({ mergeStateStatus: "BEHIND" });
    const plan = planAction(pr, context({ cooldownKeys: new Set([pr.key]) }));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain("cooldown");
  });

  test("auto-merge already enabled needs nothing", () => {
    const plan = planAction(prStatus({ autoMergeRequest: { mergeMethod: "REBASE" } }), context());
    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain("armed");
  });

  test("stack layer is never auto-merged and names its parent", () => {
    const parent = prStatus({ number: 1, headRefName: "joel/layer-1" });
    const child = prStatus({ number: 2, baseRefName: "joel/layer-1", headRefName: "joel/layer-2" });
    const parents = findStackParents([parent, child]);
    expect(parents.get(child.key)?.key).toBe(parent.key);
    const plan = planAction(child, context(), parents.get(child.key));
    expect(plan.kind).toBe("none");
    expect(plan.reason).toContain(parent.key);
  });

  test("stack detection ignores PRs in different repos", () => {
    const a = prStatus({ number: 1, headRefName: "shared" });
    const b = prStatus(
      { number: 2, baseRefName: "shared" },
      { owner: "other", repo: "r", number: 2 },
    );
    expect(findStackParents([a, b]).size).toBe(0);
  });
});
