import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, addManualPr, removePr, configDir } from "../src/config.ts";

const ref = { owner: "acme", repo: "widgets", number: 5 };

describe("config", () => {
  test("configDir honors PRBB_CONFIG_DIR, then XDG, then ~/.config", () => {
    expect(configDir({ PRBB_CONFIG_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/prbb");
    expect(configDir({})).toContain("/.config/prbb");
  });

  test("round-trips manual PRs through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "prbb-test-"));
    const path = join(dir, "config.json");
    try {
      saveConfig(addManualPr(loadConfig(path), ref), path);
      expect(loadConfig(path).manualPrs).toEqual([ref]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("add is idempotent and clears ignore", () => {
    let config = removePr(loadConfig("/nonexistent"), ref);
    expect(config.ignoredPrs).toEqual([ref]);
    config = addManualPr(addManualPr(config, ref), ref);
    expect(config.manualPrs).toEqual([ref]);
    expect(config.ignoredPrs).toEqual([]);
  });

  test("remove drops manual entry and ignores it for discovery", () => {
    const config = removePr(addManualPr(loadConfig("/nonexistent"), ref), ref);
    expect(config.manualPrs).toEqual([]);
    expect(config.ignoredPrs).toEqual([ref]);
  });
});
