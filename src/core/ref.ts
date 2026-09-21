import { fail } from "../util/errors.ts";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function formatRef(ref: PrRef): string {
  return prKey(ref);
}

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

const urlPattern = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const shorthandPattern = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const repoPattern = /^([^/\s]+)\/([^/\s]+)$/;

// Parses a PR reference: full URL, "owner/repo#123", or a bare number.
// A bare number needs a repo from --repo or the current directory; without one it fails
// as ambiguous so agents get a structured error instead of a guess.
export function parsePrRef(input: string, contextRepo?: string): PrRef {
  const trimmed = input.trim();

  const url = trimmed.match(urlPattern);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]!) };

  const shorthand = trimmed.match(shorthandPattern);
  if (shorthand) {
    return { owner: shorthand[1]!, repo: shorthand[2]!, number: Number(shorthand[3]!) };
  }

  if (/^#?\d+$/.test(trimmed)) {
    const number = Number(trimmed.replace("#", ""));
    if (!contextRepo) {
      fail(
        `PR number "${input}" is ambiguous: not inside a GitHub repository and no --repo given. ` +
          `Use --repo owner/name or a full PR URL.`,
        "usage",
      );
    }
    const repo = contextRepo.match(repoPattern);
    if (!repo) fail(`Invalid repository "${contextRepo}"; expected owner/name.`, "usage");
    return { owner: repo[1]!, repo: repo[2]!, number };
  }

  fail(
    `Cannot parse PR reference "${input}". Use a URL, owner/repo#123, or a number with --repo.`,
    "usage",
  );
}
