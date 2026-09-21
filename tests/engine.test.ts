import { describe, expect, test } from "bun:test";
import { Engine, type EngineEvent } from "../src/engine.ts";
import { GhClient } from "../src/gh.ts";
import { fakeRunner, ghPr } from "./fakes.ts";
import type { GhPrJson } from "../src/core/model.ts";
import type { PrbbConfig } from "../src/config.ts";

const emptyConfig: PrbbConfig = { manualPrs: [], ignoredPrs: [], repoPaths: {} };

function ghScript(pr: GhPrJson, searchRows: Array<{ number: number; repo: string }>) {
  return [
    { match: "api user", result: { stdout: "joel\n" } },
    {
      match: "search prs",
      result: {
        stdout: JSON.stringify(
          searchRows.map((r) => ({ number: r.number, repository: { nameWithOwner: r.repo } })),
        ),
      },
    },
    { match: "pr view", result: { stdout: JSON.stringify(pr) } },
    {
      match: "api repos/",
      result: { stdout: JSON.stringify({ rebase: true, squash: true, merge: true }) },
    },
  ];
}

function collect(engine: Engine): EngineEvent[] {
  const events: EngineEvent[] = [];
  engine.onEvent((e) => events.push(e));
  return events;
}

describe("Engine.pollOnce", () => {
  test("discovers PRs, updates status, and enables auto-merge on a ready PR", async () => {
    const { run, calls } = fakeRunner(ghScript(ghPr(), [{ number: 1, repo: "acme/widgets" }]));
    const engine = new Engine(new GhClient(run), emptyConfig, {
      includeDrafts: false,
      watchOnly: false,
    });
    const events = collect(engine);
    await engine.pollOnce();

    expect(engine.prs.get("acme/widgets#1")?.checks).toBe("passing");
    const action = events.find((e) => e.type === "action");
    expect(action && action.type === "action" && action.action.kind).toBe("enableAutoMerge");
    expect(action && action.type === "action" && action.result).toBe("done");
    const merge = calls.find((c) => c.args.includes("merge"));
    expect(merge?.args).toContain("--auto");
    expect(merge?.args).toContain("--rebase");
  });

  test("watch-only mode plans but never runs write commands", async () => {
    const { run, calls } = fakeRunner(ghScript(ghPr(), [{ number: 1, repo: "acme/widgets" }]));
    const engine = new Engine(new GhClient(run), emptyConfig, {
      includeDrafts: false,
      watchOnly: true,
    });
    const events = collect(engine);
    await engine.pollOnce();

    expect(calls.some((c) => c.args.includes("merge"))).toBe(false);
    expect(calls.some((c) => c.args.includes("update-branch"))).toBe(false);
    const action = events.find((e) => e.type === "action");
    expect(action && action.type === "action" && action.result).toBe("planned");
  });

  test("behind PR triggers update-branch", async () => {
    const { run, calls } = fakeRunner(
      ghScript(ghPr({ mergeStateStatus: "BEHIND" }), [{ number: 1, repo: "acme/widgets" }]),
    );
    const engine = new Engine(new GhClient(run), emptyConfig, {
      includeDrafts: false,
      watchOnly: false,
    });
    await engine.pollOnce();
    expect(calls.some((c) => c.args.includes("update-branch"))).toBe(true);
  });

  test("conflicting PR emits a conflict event and no writes", async () => {
    const { run, calls } = fakeRunner(
      ghScript(ghPr({ mergeable: "CONFLICTING" }), [{ number: 1, repo: "acme/widgets" }]),
    );
    const engine = new Engine(new GhClient(run), emptyConfig, {
      includeDrafts: false,
      watchOnly: false,
    });
    const events = collect(engine);
    await engine.pollOnce();
    expect(events.some((e) => e.type === "conflict")).toBe(true);
    expect(calls.some((c) => c.args.includes("merge") || c.args.includes("update-branch"))).toBe(
      false,
    );
  });

  test("action cooldown prevents repeating the same write on the next poll", async () => {
    const { run, calls } = fakeRunner(
      ghScript(ghPr({ mergeStateStatus: "BEHIND" }), [{ number: 1, repo: "acme/widgets" }]),
    );
    let clock = 0;
    const engine = new Engine(new GhClient(run), emptyConfig, {
      includeDrafts: false,
      watchOnly: false,
      actionCooldownMs: 1000,
      now: () => clock,
    });
    await engine.pollOnce();
    clock = 500; // still inside cooldown
    await engine.pollOnce();
    expect(calls.filter((c) => c.args.includes("update-branch")).length).toBe(1);
    clock = 2000; // cooldown expired
    await engine.pollOnce();
    expect(calls.filter((c) => c.args.includes("update-branch")).length).toBe(2);
  });

  test("manual PRs merge with discovered ones without duplicates", async () => {
    const { run, calls } = fakeRunner(ghScript(ghPr(), [{ number: 1, repo: "acme/widgets" }]));
    const config: PrbbConfig = {
      manualPrs: [{ owner: "acme", repo: "widgets", number: 1 }],
      ignoredPrs: [],
      repoPaths: {},
    };
    const engine = new Engine(new GhClient(run), config, { includeDrafts: false, watchOnly: true });
    await engine.pollOnce();
    expect(engine.prs.size).toBe(1);
    expect(engine.prs.get("acme/widgets#1")?.source).toBe("manual");
    expect(calls.filter((c) => c.args.includes("view") && c.args.includes("pr")).length).toBe(1);
  });

  test("ignored PRs are excluded from discovery", async () => {
    const { run } = fakeRunner(ghScript(ghPr(), [{ number: 1, repo: "acme/widgets" }]));
    const config: PrbbConfig = {
      manualPrs: [],
      ignoredPrs: [{ owner: "acme", repo: "widgets", number: 1 }],
      repoPaths: {},
    };
    const engine = new Engine(new GhClient(run), config, { includeDrafts: false, watchOnly: true });
    await engine.pollOnce();
    expect(engine.prs.size).toBe(0);
  });

  test("poll failure emits error and backs off; recovery resets the delay", async () => {
    let failing = true;
    const { run } = fakeRunner([]);
    const flaky: typeof run = async (command, args, options) => {
      if (failing) return { code: 1, stdout: "", stderr: "boom" };
      const line = [command, ...args].join(" ");
      if (line.includes("api user")) return { code: 0, stdout: "joel", stderr: "" };
      if (line.includes("search prs")) return { code: 0, stdout: "[]", stderr: "" };
      return run(command, args, options);
    };
    const engine = new Engine(new GhClient(flaky), emptyConfig, {
      includeDrafts: false,
      watchOnly: true,
      backoff: { baseMs: 100, maxMs: 1000 },
    });
    const events = collect(engine);
    expect(await engine.pollOnce()).toBe(200);
    expect(await engine.pollOnce()).toBe(400);
    expect(events.some((e) => e.type === "error")).toBe(true);
    failing = false;
    expect(await engine.pollOnce()).toBe(100);
  });

  test("newly merged PR emits a merged event", async () => {
    let state: GhPrJson["state"] = "OPEN";
    const { run } = fakeRunner([]);
    const dynamic: typeof run = async (command, args) => {
      const line = [command, ...args].join(" ");
      if (line.includes("api user")) return { code: 0, stdout: "joel", stderr: "" };
      if (line.includes("search prs")) {
        return {
          code: 0,
          stdout: JSON.stringify([{ number: 1, repository: { nameWithOwner: "acme/widgets" } }]),
          stderr: "",
        };
      }
      if (line.includes("pr view")) {
        return { code: 0, stdout: JSON.stringify(ghPr({ state })), stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const engine = new Engine(new GhClient(dynamic), emptyConfig, {
      includeDrafts: false,
      watchOnly: true,
    });
    const events = collect(engine);
    await engine.pollOnce();
    state = "MERGED";
    await engine.pollOnce();
    expect(events.filter((e) => e.type === "merged").length).toBe(1);
  });
});
