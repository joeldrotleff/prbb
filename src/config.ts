import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { PrRef } from "./core/ref.ts";
import { prKey } from "./core/ref.ts";

export interface PrbbConfig {
  // PRs added by hand with `prbb add`.
  manualPrs: PrRef[];
  // PRs the user asked prbb to ignore even if discovery finds them.
  ignoredPrs: PrRef[];
  // Optional map of "owner/repo" -> local checkout path for the Herdr conflict flow.
  repoPaths: Record<string, string>;
}

const emptyConfig: PrbbConfig = { manualPrs: [], ignoredPrs: [], repoPaths: {} };

export function configDir(env: Record<string, string | undefined> = process.env): string {
  if (env.PRBB_CONFIG_DIR) return env.PRBB_CONFIG_DIR;
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "prbb");
}

export function configPath(env?: Record<string, string | undefined>): string {
  return join(configDir(env), "config.json");
}

export function loadConfig(path = configPath()): PrbbConfig {
  if (!existsSync(path)) return structuredClone(emptyConfig);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    manualPrs: raw.manualPrs ?? [],
    ignoredPrs: raw.ignoredPrs ?? [],
    repoPaths: raw.repoPaths ?? {},
  };
}

export function saveConfig(config: PrbbConfig, path = configPath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function addManualPr(config: PrbbConfig, ref: PrRef): PrbbConfig {
  const key = prKey(ref);
  return {
    ...config,
    manualPrs: config.manualPrs.some((p) => prKey(p) === key)
      ? config.manualPrs
      : [...config.manualPrs, ref],
    ignoredPrs: config.ignoredPrs.filter((p) => prKey(p) !== key),
  };
}

// Removing a manual PR also marks it ignored so discovery does not re-add it.
export function removePr(config: PrbbConfig, ref: PrRef): PrbbConfig {
  const key = prKey(ref);
  return {
    ...config,
    manualPrs: config.manualPrs.filter((p) => prKey(p) !== key),
    ignoredPrs: config.ignoredPrs.some((p) => prKey(p) === key)
      ? config.ignoredPrs
      : [...config.ignoredPrs, ref],
  };
}
