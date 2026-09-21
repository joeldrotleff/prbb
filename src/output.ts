import type { PrStatus } from "./core/model.ts";
import type { EngineEvent } from "./engine.ts";
import type { PlannedAction } from "./core/plan.ts";

// Machine-readable snapshot for `prbb status --json`. Stable shape; add fields, don't rename.
export function statusJson(prs: PrStatus[], plans: PlannedAction[]): string {
  const planByKey = new Map(plans.map((p) => [p.pr.key, p]));
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      prs: prs.map((pr) => ({
        ...pr,
        plan: planByKey.get(pr.key)
          ? { kind: planByKey.get(pr.key)!.kind, reason: planByKey.get(pr.key)!.reason }
          : null,
      })),
    },
    null,
    2,
  );
}

// One JSON object per line for `prbb watch --jsonl`.
export function eventJsonl(event: EngineEvent): string {
  return JSON.stringify(event);
}
