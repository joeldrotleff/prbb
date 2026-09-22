import type { PrRef } from "./ref.ts";
import { prKey } from "./ref.ts";

// Subset of `gh pr view --json` output that prbb reads.
export interface GhPrJson {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus:
    "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null;
  autoMergeRequest: { enabledAt?: string; mergeMethod?: string } | null;
  baseRefName: string;
  headRefName: string;
  statusCheckRollup: Array<{
    __typename?: string;
    name?: string; // CheckRun
    context?: string; // StatusContext
    status?: string;
    conclusion?: string;
    state?: string;
  }> | null;
}

export type ChecksState = "passing" | "failing" | "pending" | "none";

export interface PrStatus {
  ref: PrRef;
  key: string;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  checks: ChecksState;
  checksTotal: number;
  checksFailed: number;
  checksPending: number;
  runningChecks: string[];
  failedChecks: string[];
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState: GhPrJson["mergeStateStatus"];
  autoMergeEnabled: boolean;
  autoMergeMethod: string | null;
  source: "discovered" | "manual";
  fetchedAt: string;
}

export const prStatusJsonFields =
  "number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,autoMergeRequest,baseRefName,headRefName,statusCheckRollup";

function checkName(check: NonNullable<GhPrJson["statusCheckRollup"]>[number]): string {
  return check.name ?? check.context ?? "unnamed check";
}

function summarizeChecks(rollup: GhPrJson["statusCheckRollup"]): {
  checks: ChecksState;
  total: number;
  failed: number;
  pending: number;
  runningChecks: string[];
  failedChecks: string[];
} {
  if (!rollup || rollup.length === 0) {
    return { checks: "none", total: 0, failed: 0, pending: 0, runningChecks: [], failedChecks: [] };
  }
  const runningChecks: string[] = [];
  const failedChecks: string[] = [];
  for (const check of rollup) {
    // CheckRun uses status/conclusion; StatusContext uses state.
    const outcome = (check.conclusion ?? check.state ?? "").toUpperCase();
    const status = (check.status ?? "").toUpperCase();
    if (status && status !== "COMPLETED") runningChecks.push(checkName(check));
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(outcome)) {
      failedChecks.push(checkName(check));
    } else if (outcome === "PENDING" || outcome === "EXPECTED" || outcome === "") {
      runningChecks.push(checkName(check));
    }
  }
  const failed = failedChecks.length;
  const pending = runningChecks.length;
  const checks: ChecksState = failed > 0 ? "failing" : pending > 0 ? "pending" : "passing";
  return { checks, total: rollup.length, failed, pending, runningChecks, failedChecks };
}

export function mapPrStatus(
  ref: PrRef,
  raw: GhPrJson,
  source: "discovered" | "manual",
  fetchedAt = new Date().toISOString(),
): PrStatus {
  const { checks, total, failed, pending, runningChecks, failedChecks } = summarizeChecks(
    raw.statusCheckRollup,
  );
  return {
    ref,
    key: prKey(ref),
    title: raw.title,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    checks,
    checksTotal: total,
    checksFailed: failed,
    checksPending: pending,
    runningChecks,
    failedChecks,
    reviewDecision: raw.reviewDecision ? raw.reviewDecision : "NONE",
    mergeable: raw.mergeable,
    mergeState: raw.mergeStateStatus,
    autoMergeEnabled: raw.autoMergeRequest != null,
    autoMergeMethod: raw.autoMergeRequest?.mergeMethod ?? null,
    source,
    fetchedAt,
  };
}
