import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Engine, EngineEvent } from "../engine.ts";
import type { PrStatus } from "../core/model.ts";
import type { GhClient } from "../gh.ts";
import { startConflictAgent } from "../herdr.ts";
import type { PrbbConfig } from "../config.ts";

interface LogLine {
  at: string;
  text: string;
  level: "info" | "warn" | "error";
}

// Status text avoids relying on color alone: each state has a distinct symbol/word.
function checksLabel(pr: PrStatus): { text: string; color: string } {
  switch (pr.checks) {
    case "passing":
      return { text: "✓ checks", color: "green" };
    case "failing":
      return { text: `✗ ${pr.checksFailed} failing`, color: "red" };
    case "pending":
      return { text: `… ${pr.checksPending} running`, color: "yellow" };
    case "none":
      return { text: "– no checks", color: "gray" };
  }
}

function reviewLabel(pr: PrStatus): { text: string; color: string } {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { text: "✓ approved", color: "green" };
    case "CHANGES_REQUESTED":
      return { text: "✗ changes", color: "red" };
    case "REVIEW_REQUIRED":
      return { text: "○ review req", color: "yellow" };
    default:
      return { text: "– no review", color: "gray" };
  }
}

function mergeLabel(pr: PrStatus): { text: string; color: string } {
  if (pr.state === "MERGED") return { text: "MERGED", color: "magenta" };
  if (pr.state === "CLOSED") return { text: "CLOSED", color: "gray" };
  if (pr.mergeable === "CONFLICTING") return { text: "‼ CONFLICT", color: "red" };
  if (pr.mergeState === "BEHIND") return { text: "↓ behind", color: "yellow" };
  if (pr.mergeState === "CLEAN") return { text: "✓ clean", color: "green" };
  if (pr.mergeState === "BLOCKED") return { text: "◼ blocked", color: "yellow" };
  return { text: pr.mergeState.toLowerCase(), color: "gray" };
}

function eventText(event: EngineEvent): LogLine | null {
  const at = new Date().toLocaleTimeString();
  switch (event.type) {
    case "poll-end":
      return {
        at,
        text: `refreshed ${event.prCount} PRs; next poll in ${Math.round(event.nextDelayMs / 1000)}s`,
        level: "info",
      };
    case "action":
      return {
        at,
        text: `${event.result === "planned" ? "would " : ""}${event.action.kind} ${event.action.pr.key}: ${event.action.reason}${event.result === "failed" ? ` — FAILED: ${event.detail}` : ""}`,
        level: event.result === "failed" ? "error" : "info",
      };
    case "conflict":
      return {
        at,
        text: `CONFLICT on ${event.pr.key} — press c to start a Herdr agent`,
        level: "warn",
      };
    case "merged":
      return { at, text: `MERGED ${event.pr.key} 🎉`, level: "info" };
    case "error":
      return { at, text: `poll error: ${event.message}`, level: "error" };
    default:
      return null;
  }
}

export function App({
  engine,
  gh,
  config,
  watchOnly,
}: {
  engine: Engine;
  gh: GhClient;
  config: PrbbConfig;
  watchOnly: boolean;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, forceRender] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [selected, setSelected] = useState(0);
  const [showHelp, setShowHelp] = useState(false);

  const pushLog = useCallback((line: LogLine) => {
    setLog((prev) => [...prev.slice(-49), line]);
  }, []);

  useEffect(() => {
    const unsubscribe = engine.onEvent((event) => {
      const line = eventText(event);
      if (line) pushLog(line);
      forceRender((n) => n + 1);
    });
    void engine.runLoop();
    return () => {
      unsubscribe();
      engine.stop();
    };
  }, [engine, pushLog]);

  const prs = [...engine.prs.values()].sort((a, b) => a.key.localeCompare(b.key));
  const current = prs[Math.min(selected, Math.max(prs.length - 1, 0))];

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      engine.stop();
      exit();
    } else if (input === "?" || input === "h") setShowHelp((v) => !v);
    else if (key.downArrow || input === "j") setSelected((s) => Math.min(s + 1, prs.length - 1));
    else if (key.upArrow || input === "k") setSelected((s) => Math.max(s - 1, 0));
    else if (input === "r") {
      pushLog({ at: new Date().toLocaleTimeString(), text: "manual refresh", level: "info" });
      void engine.pollOnce().then(() => forceRender((n) => n + 1));
    } else if (input === "o" && current) {
      void gh.openInBrowser(current.ref);
    } else if (input === "c" && current && current.mergeable === "CONFLICTING") {
      startConflictAgent(current, { repoPaths: config.repoPaths })
        .then((result) =>
          pushLog({
            at: new Date().toLocaleTimeString(),
            text:
              result.status === "already-running"
                ? `conflict agent already running: ${result.workspaceLabel}`
                : `started conflict agent: ${result.workspaceLabel}`,
            level: "info",
          }),
        )
        .catch((error) =>
          pushLog({
            at: new Date().toLocaleTimeString(),
            text: String(error.message ?? error),
            level: "error",
          }),
        );
    }
  });

  const width = stdout?.columns ?? 120;
  const titleWidth = Math.max(20, width - 78);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>prbb</Text>
        <Text> — babysitting {prs.length} PRs</Text>
        {watchOnly && <Text color="yellow"> [watch-only: no writes]</Text>}
        <Text dimColor> press ? for help, q to quit</Text>
      </Box>
      {prs.length === 0 && (
        <Text dimColor>No open PRs found. Add one with `prbb add &lt;url&gt;`.</Text>
      )}
      {prs.map((pr, index) => {
        const checks = checksLabel(pr);
        const review = reviewLabel(pr);
        const merge = mergeLabel(pr);
        return (
          <Box key={pr.key} gap={1}>
            <Text inverse={index === selected}>
              {pr.isDraft ? "◇" : "●"} {pr.key.padEnd(36).slice(0, 36)}
            </Text>
            <Text>{pr.title.slice(0, titleWidth).padEnd(titleWidth)}</Text>
            <Text color={checks.color}>{checks.text.padEnd(13)}</Text>
            <Text color={review.color}>{review.text.padEnd(13)}</Text>
            <Text color={merge.color}>{merge.text.padEnd(11)}</Text>
            <Text color={pr.autoMergeEnabled ? "green" : "gray"}>
              {pr.autoMergeEnabled
                ? `auto:${pr.autoMergeMethod?.toLowerCase() ?? "on"}`
                : "auto:off"}
            </Text>
            <Text dimColor>{new Date(pr.fetchedAt).toLocaleTimeString()}</Text>
          </Box>
        );
      })}
      {showHelp && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Keys</Text>
          <Text>↑/↓ or j/k select · r refresh · o open in browser · c start conflict agent</Text>
          <Text>? or h toggle help · q quit</Text>
          <Text dimColor>
            Add/remove PRs from the shell: prbb add &lt;ref&gt; / prbb remove &lt;ref&gt;
          </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>
          activity
        </Text>
        {log.slice(-8).map((line, index) => (
          <Text
            key={`${line.at}-${index}`}
            color={line.level === "error" ? "red" : line.level === "warn" ? "yellow" : undefined}
            dimColor={line.level === "info"}
          >
            {line.at} {line.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
