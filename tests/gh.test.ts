import { describe, expect, test } from "bun:test";
import { GhClient } from "../src/gh.ts";
import { PrbbError } from "../src/util/errors.ts";
import { fakeRunner, ghPr } from "./fakes.ts";

describe("GhClient", () => {
  test("auth errors map to the authFailure exit code", async () => {
    const { run } = fakeRunner([
      {
        match: "api user",
        result: { code: 1, stderr: "To get started with GitHub CLI, please run: gh auth login" },
      },
    ]);
    try {
      await new GhClient(run).currentUser();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PrbbError);
      expect((error as PrbbError).code).toBe("authFailure");
    }
  });

  test("searchAuthoredPrs excludes drafts unless asked", async () => {
    const { run, calls } = fakeRunner([{ match: "search prs", result: { stdout: "[]" } }]);
    const gh = new GhClient(run);
    await gh.searchAuthoredPrs("joel", false);
    expect(calls[0]!.args).toContain("draft:false");
    await gh.searchAuthoredPrs("joel", true);
    expect(calls[1]!.args).not.toContain("draft:false");
  });

  test("updateBranch passes --rebase when asked", async () => {
    const { run, calls } = fakeRunner([]);
    await new GhClient(run).updateBranch({ owner: "a", repo: "b", number: 1 }, { rebase: true });
    expect(calls[0]!.args).toContain("--rebase");
  });

  test("updateBranch failures map to branchUpdateFailed", async () => {
    const { run } = fakeRunner([
      {
        match: "update-branch",
        result: { code: 1, stderr: "merge conflict between base and head" },
      },
    ]);
    try {
      await new GhClient(run).updateBranch({ owner: "a", repo: "b", number: 1 });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as PrbbError).code).toBe("branchUpdateFailed");
    }
  });

  test("enableAutoMerge passes --auto and the chosen method", async () => {
    const { run, calls } = fakeRunner([]);
    await new GhClient(run).enableAutoMerge({ owner: "a", repo: "b", number: 7 }, "rebase");
    expect(calls[0]!.args).toEqual(["pr", "merge", "7", "--repo", "a/b", "--auto", "--rebase"]);
  });

  test("unresolvedThreads queries GraphQL and parses the count", async () => {
    const { run, calls } = fakeRunner([{ match: "graphql", result: { stdout: "3\n" } }]);
    const count = await new GhClient(run).unresolvedThreads({ owner: "a", repo: "b", number: 7 });
    expect(count).toBe(3);
    expect(calls[0]!.args.join(" ")).toContain("reviewThreads");
  });

  test("viewPr parses gh JSON", async () => {
    const { run } = fakeRunner([{ match: "pr view", result: { stdout: JSON.stringify(ghPr()) } }]);
    const pr = await new GhClient(run).viewPr({ owner: "acme", repo: "widgets", number: 1 });
    expect(pr.title).toBe("Fix the thing");
  });
});
