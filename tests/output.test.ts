import { describe, expect, test } from "bun:test";
import { statusJson, eventJsonl } from "../src/output.ts";
import { prStatus } from "./fakes.ts";

describe("statusJson", () => {
  test("includes each PR with its plan", () => {
    const pr = prStatus();
    const parsed = JSON.parse(statusJson([pr], [{ kind: "enableAutoMerge", pr, reason: "ready" }]));
    expect(parsed.prs).toHaveLength(1);
    expect(parsed.prs[0].key).toBe("acme/widgets#1");
    expect(parsed.prs[0].plan).toEqual({ kind: "enableAutoMerge", reason: "ready" });
  });

  test("PR without a plan gets plan null", () => {
    const parsed = JSON.parse(statusJson([prStatus()], []));
    expect(parsed.prs[0].plan).toBeNull();
  });
});

describe("eventJsonl", () => {
  test("emits one parseable line per event", () => {
    const line = eventJsonl({ type: "pr-updated", pr: prStatus() });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).type).toBe("pr-updated");
  });
});
