import { describe, expect, test } from "bun:test";
import { prStatus, ghPr } from "./fakes.ts";
import { mapPrStatus } from "../src/core/model.ts";

describe("mapPrStatus", () => {
  test("summarizes passing checks", () => {
    const pr = prStatus();
    expect(pr.checks).toBe("passing");
    expect(pr.checksTotal).toBe(1);
  });

  test("a single failure marks checks failing even with pending runs", () => {
    const pr = prStatus({
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS" },
      ],
    });
    expect(pr.checks).toBe("failing");
    expect(pr.checksFailed).toBe(1);
    expect(pr.checksPending).toBe(1);
  });

  test("legacy StatusContext state is read when conclusion is absent", () => {
    const pr = prStatus({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] });
    expect(pr.checks).toBe("failing");
  });

  test("no rollup means no checks", () => {
    expect(prStatus({ statusCheckRollup: null }).checks).toBe("none");
    expect(prStatus({ statusCheckRollup: [] }).checks).toBe("none");
  });

  test("null reviewDecision maps to NONE", () => {
    expect(prStatus({ reviewDecision: null }).reviewDecision).toBe("NONE");
    expect(prStatus({ reviewDecision: "" }).reviewDecision).toBe("NONE");
  });

  test("autoMergeRequest presence sets autoMergeEnabled and method", () => {
    const pr = prStatus({ autoMergeRequest: { mergeMethod: "REBASE" } });
    expect(pr.autoMergeEnabled).toBe(true);
    expect(pr.autoMergeMethod).toBe("REBASE");
  });

  test("keeps ref and source", () => {
    const pr = mapPrStatus({ owner: "x", repo: "y", number: 9 }, ghPr(), "manual", "t");
    expect(pr.key).toBe("x/y#9");
    expect(pr.source).toBe("manual");
    expect(pr.fetchedAt).toBe("t");
  });
});
