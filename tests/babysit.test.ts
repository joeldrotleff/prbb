import { describe, expect, test } from "bun:test";
import { babysit, resolveRef, pickMergeMethod } from "../src/babysit.ts";
import { GhClient } from "../src/gh.ts";
import { PrbbError, type ExitCodeName } from "../src/util/errors.ts";
import { fakeRunner, ghPr } from "./fakes.ts";
import type { GhPrJson } from "../src/core/model.ts";

const ref = { owner: "acme", repo: "widgets", number: 1 };

// Drives babysit with a scripted sequence of PR states; each poll consumes one.
function deps(
  states: Array<Partial<GhPrJson>>,
  extraScript: Parameters<typeof fakeRunner>[0] = [],
) {
  let poll = 0;
  const { run, calls } = fakeRunner([
    {
      match: "api repos/",
      result: { stdout: JSON.stringify({ rebase: true, squash: true, merge: true }) },
    },
    ...extraScript,
  ]);
  const scripted: typeof run = async (command, args, options) => {
    if (args.includes("view")) {
      const state = states[Math.min(poll, states.length - 1)];
      poll += 1;
      return { code: 0, stdout: JSON.stringify(ghPr(state)), stderr: "" };
    }
    return run(command, args, options);
  };
  const log: string[] = [];
  return {
    calls,
    log,
    deps: {
      gh: new GhClient(scripted),
      log: (line: string) => log.push(line),
      sleep: async () => {},
      updateCooldownMs: 0,
    },
  };
}

describe("resolveRef", () => {
  test("org/number resolves through the user's open PRs in that org", async () => {
    const { run, calls } = fakeRunner([
      { match: "api user", result: { stdout: "joel" } },
      {
        match: "search prs",
        result: {
          stdout: JSON.stringify([{ number: 1691, repository: { nameWithOwner: "acme/quest" } }]),
        },
      },
    ]);
    const resolved = await resolveRef({ owner: "acme", number: 1691 }, new GhClient(run));
    expect(resolved).toEqual({ owner: "acme", repo: "quest", number: 1691 });
    expect(calls.find((c) => c.args.includes("search"))?.args).toContain("--owner");
  });

  test("no match fails with usage code", async () => {
    const { run } = fakeRunner([
      { match: "api user", result: { stdout: "joel" } },
      { match: "search prs", result: { stdout: "[]" } },
    ]);
    await expect(resolveRef({ owner: "acme", number: 9 }, new GhClient(run))).rejects.toThrow(
      /No open PR #9/,
    );
  });

  test("same number in two repos fails as ambiguous", async () => {
    const { run } = fakeRunner([
      { match: "api user", result: { stdout: "joel" } },
      {
        match: "search prs",
        result: {
          stdout: JSON.stringify([
            { number: 5, repository: { nameWithOwner: "acme/a" } },
            { number: 5, repository: { nameWithOwner: "acme/b" } },
          ]),
        },
      },
    ]);
    await expect(resolveRef({ owner: "acme", number: 5 }, new GhClient(run))).rejects.toThrow(
      /ambiguous/,
    );
  });

  test("full refs pass through without any gh calls", async () => {
    const { run, calls } = fakeRunner([]);
    expect(await resolveRef(ref, new GhClient(run))).toEqual(ref);
    expect(calls).toHaveLength(0);
  });
});

describe("babysit", () => {
  test("enables rebase auto-merge, then returns when the PR merges", async () => {
    const {
      deps: d,
      calls,
      log,
    } = deps([{}, { autoMergeRequest: { mergeMethod: "REBASE" } }, { state: "MERGED" }]);
    await babysit(ref, d);
    const merge = calls.find((c) => c.args.includes("merge"));
    expect(merge?.args).toEqual([
      "pr",
      "merge",
      "1",
      "--repo",
      "acme/widgets",
      "--auto",
      "--rebase",
    ]);
    expect(log.some((l) => l.includes("merged"))).toBe(true);
  });

  test("rebases via gh when the branch falls behind", async () => {
    const { deps: d, calls } = deps([
      { mergeStateStatus: "BEHIND", autoMergeRequest: { mergeMethod: "REBASE" } },
      { state: "MERGED" },
    ]);
    await babysit(ref, d);
    const update = calls.find((c) => c.args.includes("update-branch"));
    expect(update?.args).toContain("--rebase");
  });

  test("merge conflict fails with the conflict exit code and PR url", async () => {
    const { deps: d } = deps([{ mergeable: "CONFLICTING" }]);
    try {
      await babysit(ref, d);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PrbbError);
      expect((error as PrbbError).code).toBe("conflictNeedsHerdr");
      expect((error as PrbbError).message).toContain("merge conflict");
      expect((error as PrbbError).message).toContain("pull/1");
    }
  });

  test("failing checks, changes requested, drafts, and closed PRs all error", async () => {
    const cases: Array<{ state: Partial<GhPrJson>; code: ExitCodeName }> = [
      {
        state: { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
        code: "blocked",
      },
      { state: { reviewDecision: "CHANGES_REQUESTED" }, code: "blocked" },
      { state: { isDraft: true }, code: "blocked" },
      { state: { state: "CLOSED" }, code: "prClosed" },
    ];
    for (const { state, code } of cases) {
      const { deps: d } = deps([state]);
      try {
        await babysit(ref, d);
        throw new Error("expected failure");
      } catch (error) {
        expect((error as PrbbError).code).toBe(code);
      }
    }
  });

  test("poll failures back off and recover instead of exiting", async () => {
    let failed = false;
    const { run } = fakeRunner([
      {
        match: "api repos/",
        result: { stdout: JSON.stringify({ rebase: true, squash: true, merge: true }) },
      },
    ]);
    const flaky: typeof run = async (command, args, options) => {
      if (args.includes("view")) {
        if (!failed) {
          failed = true;
          return { code: 1, stdout: "", stderr: "HTTP 502" };
        }
        return { code: 0, stdout: JSON.stringify(ghPr({ state: "MERGED" })), stderr: "" };
      }
      return run(command, args, options);
    };
    const log: string[] = [];
    await babysit(ref, {
      gh: new GhClient(flaky),
      log: (line) => log.push(line),
      sleep: async () => {},
    });
    expect(log.some((l) => l.includes("poll failed"))).toBe(true);
    expect(log.some((l) => l.includes("merged"))).toBe(true);
  });

  test("a check starting to run prints a new status line with its name", async () => {
    const armed = { autoMergeRequest: { mergeMethod: "REBASE" } };
    const { deps: d, log } = deps([
      { ...armed, statusCheckRollup: [] },
      { ...armed, statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }] },
      { state: "MERGED" },
    ]);
    await babysit(ref, d);
    const checkLines = log.filter((l) => l.includes("checks:"));
    expect(checkLines).toHaveLength(2);
    expect(checkLines[1]).toContain("running: build");
  });

  test("failing checks error names the checks", async () => {
    const { deps: d } = deps([
      { statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }] },
    ]);
    await expect(babysit(ref, d)).rejects.toThrow(/failing check\(s\): test/);
  });

  test("warns once about needed approval and unresolved conversations", async () => {
    const needsReview = {
      reviewDecision: "REVIEW_REQUIRED" as const,
      autoMergeRequest: { mergeMethod: "REBASE" },
    };
    const { deps: d, log } = deps(
      [needsReview, needsReview, { state: "MERGED" }],
      [{ match: "graphql", result: { stdout: "2\n" } }],
    );
    await babysit(ref, d);
    expect(log.filter((l) => l.includes("needs review approval"))).toHaveLength(1);
    expect(log.filter((l) => l.includes("2 unresolved conversations"))).toHaveLength(1);
  });

  test("no warnings when approved with no unresolved threads", async () => {
    const { deps: d, log } = deps(
      [{ autoMergeRequest: { mergeMethod: "REBASE" } }, { state: "MERGED" }],
      [{ match: "graphql", result: { stdout: "0\n" } }],
    );
    await babysit(ref, d);
    expect(log.some((l) => l.includes("⚠️") || l.includes("💬"))).toBe(false);
  });

  test("logs new approvals by name but not pre-existing ones", async () => {
    const armed = { autoMergeRequest: { mergeMethod: "REBASE" } };
    const alice = { author: { login: "alice" }, state: "APPROVED" };
    const bob = { author: { login: "bob" }, state: "APPROVED" };
    const { deps: d, log } = deps([
      { ...armed, latestReviews: [alice] },
      { ...armed, latestReviews: [alice, bob] },
      { state: "MERGED" },
    ]);
    await babysit(ref, d);
    expect(log.filter((l) => l.includes("✅"))).toEqual(["✅ bob approved"]);
  });

  test("logs when new commits are pushed to the branch", async () => {
    const armed = { autoMergeRequest: { mergeMethod: "REBASE" } };
    const { deps: d, log } = deps([
      { ...armed, headRefOid: "aaa" },
      { ...armed, headRefOid: "bbb" },
      { state: "MERGED" },
    ]);
    await babysit(ref, d);
    expect(log.filter((l) => l.includes("new commits"))).toHaveLength(1);
  });

  test("status line is logged only when it changes", async () => {
    const { deps: d, log } = deps([
      { autoMergeRequest: { mergeMethod: "REBASE" } },
      { autoMergeRequest: { mergeMethod: "REBASE" } },
      { state: "MERGED" },
    ]);
    await babysit(ref, d);
    expect(log.filter((l) => l.includes("checks:"))).toHaveLength(1);
  });
});
