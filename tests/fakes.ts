import type { CommandRunner, CommandResult } from "../src/util/process.ts";
import type { GhPrJson } from "../src/core/model.ts";
import type { PrStatus } from "../src/core/model.ts";
import { mapPrStatus } from "../src/core/model.ts";
import type { PrRef } from "../src/core/ref.ts";

export function ghPr(overrides: Partial<GhPrJson> = {}): GhPrJson {
  return {
    number: 1,
    title: "Fix the thing",
    url: "https://github.com/acme/widgets/pull/1",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    autoMergeRequest: null,
    baseRefName: "main",
    headRefName: "joel/fix",
    headRefOid: "abc123",
    latestReviews: [],
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

export function prStatus(overrides: Partial<GhPrJson> = {}, ref?: PrRef): PrStatus {
  const raw = ghPr(overrides);
  return mapPrStatus(
    ref ?? { owner: "acme", repo: "widgets", number: raw.number },
    raw,
    "discovered",
    "2026-01-01T00:00:00Z",
  );
}

export interface FakeCall {
  command: string;
  args: string[];
}

// Records every spawned command and answers from a fixed script keyed by a
// substring of the argv line. Unmatched commands succeed with empty output.
export function fakeRunner(script: Array<{ match: string; result: Partial<CommandResult> }>): {
  run: CommandRunner;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    const line = [command, ...args].join(" ");
    const entry = script.find((s) => line.includes(s.match));
    return { code: 0, stdout: "", stderr: "", ...entry?.result };
  };
  return { run, calls };
}
