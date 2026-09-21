import { fail } from "../util/errors.ts";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

// A reference that may still need its repo resolved (the `org/123` form).
export type PrInput = PrRef | { owner: string; number: number; repo?: undefined };

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

const urlPattern = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const repoNumberPattern = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
const ownerNumberPattern = /^([^/\s#]+)\/(\d+)$/;

// Accepts a full PR URL, owner/repo#123, or org/123 (repo resolved later by
// searching the user's open PRs in that org).
export function parsePrInput(input: string): PrInput {
  const trimmed = input.trim();

  const url = trimmed.match(urlPattern);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]!) };

  const repoNumber = trimmed.match(repoNumberPattern);
  if (repoNumber) {
    return { owner: repoNumber[1]!, repo: repoNumber[2]!, number: Number(repoNumber[3]!) };
  }

  const ownerNumber = trimmed.match(ownerNumberPattern);
  if (ownerNumber) return { owner: ownerNumber[1]!, number: Number(ownerNumber[2]!) };

  fail(
    `Cannot parse PR reference "${input}". Use org/123, owner/repo#123, or a full PR URL.`,
    "usage",
  );
}
