import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startConflictAgent } from "../src/herdr.ts";
import { PrbbError } from "../src/util/errors.ts";
import { fakeRunner, prStatus } from "./fakes.ts";

const conflictPr = prStatus({ mergeable: "CONFLICTING" });

describe("startConflictAgent", () => {
  test("outside Herdr fails with conflictNeedsHerdr and names the conflict", async () => {
    const { run, calls } = fakeRunner([]);
    try {
      await startConflictAgent(conflictPr, { run, env: {} });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PrbbError);
      expect((error as PrbbError).code).toBe("conflictNeedsHerdr");
      expect((error as PrbbError).message).toContain("acme/widgets#1");
      expect((error as PrbbError).message).toContain("Herdr");
    }
    expect(calls).toHaveLength(0);
  });

  test("reuses an existing conflict workspace instead of creating a duplicate", async () => {
    const { run, calls } = fakeRunner([
      { match: "api snapshot", result: { stdout: "🫡 Resolve conflict — widgets#1" } },
    ]);
    const result = await startConflictAgent(conflictPr, { run, env: { HERDR_ENV: "1" } });
    expect(result.status).toBe("already-running");
    expect(calls.some((c) => c.command === "wt")).toBe(false);
    expect(calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  test("creates worktree, workspace, and shipmate when none exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "prbb-herdr-"));
    mkdirSync(join(home, "code", "widgets"), { recursive: true });
    const { run, calls } = fakeRunner([
      { match: "api snapshot", result: { stdout: "{}" } },
      { match: "wt switch", result: { stdout: JSON.stringify({ path: "/wt/joel-fix" }) } },
      {
        match: "workspace create",
        result: { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } }) },
      },
    ]);
    try {
      const result = await startConflictAgent(conflictPr, {
        run,
        env: { HERDR_ENV: "1", HOME: home },
      });
      expect(result.status).toBe("started");
      expect(result.worktreePath).toBe("/wt/joel-fix");
      const wt = calls.find((c) => c.command === "wt");
      expect(wt?.args).toEqual(["switch", "joel/fix", "--format", "json", "--no-cd"]);
      const start = calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
      expect(start?.args).toContain("w1:p1");
      expect(start?.args.some((a) => a.startsWith("@") && a.endsWith(".md"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails clearly when no local checkout is known", async () => {
    const home = mkdtempSync(join(tmpdir(), "prbb-herdr-empty-"));
    const { run } = fakeRunner([{ match: "api snapshot", result: { stdout: "{}" } }]);
    try {
      await expect(
        startConflictAgent(conflictPr, { run, env: { HERDR_ENV: "1", HOME: home } }),
      ).rejects.toThrow(/repoPaths/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
