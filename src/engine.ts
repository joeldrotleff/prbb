import { GhClient } from "./gh.ts";
import type { PrbbConfig } from "./config.ts";
import type { PrRef } from "./core/ref.ts";
import { prKey } from "./core/ref.ts";
import type { PrStatus } from "./core/model.ts";
import { mapPrStatus } from "./core/model.ts";
import type { MergeMethods, PlannedAction } from "./core/plan.ts";
import { planAction, pickMergeMethod, findStackParents } from "./core/plan.ts";
import { nextPollDelay, defaultBackoff, type BackoffOptions } from "./core/backoff.ts";

export type EngineEvent =
  | { type: "poll-start"; at: string }
  | { type: "poll-end"; at: string; prCount: number; failures: number; nextDelayMs: number }
  | { type: "pr-updated"; pr: PrStatus }
  | { type: "pr-removed"; key: string; reason: string }
  | {
      type: "action";
      action: PlannedAction;
      result: "done" | "failed" | "planned";
      detail?: string;
    }
  | { type: "conflict"; pr: PrStatus }
  | { type: "merged"; pr: PrStatus }
  | { type: "error"; message: string };

export interface EngineOptions {
  includeDrafts: boolean;
  watchOnly: boolean;
  // Limit tracking to this GitHub owner/organization. Absent means all owners.
  owner?: string;
  backoff?: BackoffOptions;
  // Minimum time between write actions on the same PR.
  actionCooldownMs?: number;
  now?: () => number;
}

// Owns discovery, polling, planning, and action execution. Emits events; the TUI
// and JSONL watch mode are both thin subscribers.
export class Engine {
  readonly prs = new Map<string, PrStatus>();
  private readonly mergeMethodCache = new Map<string, MergeMethods>();
  private readonly lastActionAt = new Map<string, number>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private consecutiveFailures = 0;
  private stopped = false;
  private user: string | null = null;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly gh: GhClient,
    private readonly config: PrbbConfig,
    private readonly options: EngineOptions,
  ) {
    this.cooldownMs = options.actionCooldownMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // One full discovery + refresh + act cycle. Returns the delay before the next poll.
  async pollOnce(): Promise<number> {
    this.emit({ type: "poll-start", at: new Date().toISOString() });
    try {
      const refs = await this.trackedRefs();
      const seen = new Set<string>();
      for (const { ref, source } of refs) {
        const key = prKey(ref);
        seen.add(key);
        const raw = await this.gh.viewPr(ref);
        const previous = this.prs.get(key);
        const pr = mapPrStatus(ref, raw, source);
        this.prs.set(key, pr);
        this.emit({ type: "pr-updated", pr });
        if (pr.state === "MERGED" && previous?.state !== "MERGED") {
          this.emit({ type: "merged", pr });
        }
      }
      for (const key of [...this.prs.keys()]) {
        if (!seen.has(key)) {
          this.prs.delete(key);
          this.emit({ type: "pr-removed", key, reason: "no longer tracked" });
        }
      }
      await this.actOnPlans();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    const delay = nextPollDelay(this.consecutiveFailures, this.options.backoff ?? defaultBackoff);
    this.emit({
      type: "poll-end",
      at: new Date().toISOString(),
      prCount: this.prs.size,
      failures: this.consecutiveFailures,
      nextDelayMs: delay,
    });
    return delay;
  }

  async runLoop(): Promise<void> {
    while (!this.stopped) {
      const delay = await this.pollOnce();
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async trackedRefs(): Promise<Array<{ ref: PrRef; source: "discovered" | "manual" }>> {
    if (!this.user) this.user = await this.gh.currentUser();
    const owner = this.options.owner;
    const discovered = await this.gh.searchAuthoredPrs(
      this.user,
      this.options.includeDrafts,
      owner,
    );
    const ignored = new Set(this.config.ignoredPrs.map(prKey));
    const result = new Map<string, { ref: PrRef; source: "discovered" | "manual" }>();
    for (const ref of discovered) {
      const key = prKey(ref);
      if (!ignored.has(key)) result.set(key, { ref, source: "discovered" });
    }
    // Manual PRs win over discovery so their source stays "manual".
    // The owner filter applies to them too so the view stays org-scoped.
    for (const ref of this.config.manualPrs) {
      if (owner && ref.owner.toLowerCase() !== owner.toLowerCase()) continue;
      result.set(prKey(ref), { ref, source: "manual" });
    }
    return [...result.values()];
  }

  private cooldownKeys(): Set<string> {
    const keys = new Set<string>();
    const now = this.now();
    for (const [key, at] of this.lastActionAt) {
      if (now - at < this.cooldownMs) keys.add(key);
    }
    return keys;
  }

  async planAll(): Promise<PlannedAction[]> {
    const prs = [...this.prs.values()];
    const stackParents = findStackParents(prs);
    const cooldownKeys = this.cooldownKeys();
    const plans: PlannedAction[] = [];
    for (const pr of prs) {
      const methods = await this.mergeMethodsFor(pr);
      plans.push(
        planAction(pr, { allowedMergeMethods: methods, cooldownKeys }, stackParents.get(pr.key)),
      );
    }
    return plans;
  }

  private async mergeMethodsFor(pr: PrStatus): Promise<MergeMethods | null> {
    const repoKey = `${pr.ref.owner}/${pr.ref.repo}`;
    const cached = this.mergeMethodCache.get(repoKey);
    if (cached) return cached;
    try {
      const methods = await this.gh.repoMergeMethods(pr.ref.owner, pr.ref.repo);
      this.mergeMethodCache.set(repoKey, methods);
      return methods;
    } catch {
      return null;
    }
  }

  private async actOnPlans(): Promise<void> {
    for (const action of await this.planAll()) {
      if (action.kind === "none") continue;
      if (action.kind === "promptConflict") {
        this.emit({ type: "conflict", pr: action.pr });
        continue;
      }
      if (this.options.watchOnly) {
        this.emit({ type: "action", action, result: "planned" });
        continue;
      }
      try {
        if (action.kind === "enableAutoMerge") {
          const methods = await this.mergeMethodsFor(action.pr);
          const method = methods ? pickMergeMethod(methods) : null;
          if (!method) continue;
          await this.gh.enableAutoMerge(action.pr.ref, method);
        } else if (action.kind === "updateBranch") {
          await this.gh.updateBranch(action.pr.ref);
        }
        this.lastActionAt.set(action.pr.key, this.now());
        this.emit({ type: "action", action, result: "done" });
      } catch (error) {
        this.lastActionAt.set(action.pr.key, this.now());
        this.emit({
          type: "action",
          action,
          result: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
