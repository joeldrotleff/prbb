# prbb 👶🍼

Babysits one pull request until it merges. Enables auto-merge (rebase), rebases the branch via
GitHub whenever it falls behind, and exits with a clear error if a merge conflict or anything else
blocks the merge.

All GitHub access goes through the installed `gh` CLI and its login. prbb never stores tokens.

## Install

```sh
bun install
bun link          # makes `prbb` available on PATH
```

Requires [Bun](https://bun.sh) and an authenticated [`gh`](https://cli.github.com) (`gh auth login`).

## Use

```sh
prbb new-quest-ai/1691                        # org + PR number (repo found automatically)
prbb new-quest-ai/quest#1691                  # explicit repo
prbb https://github.com/acme/widgets/pull/42  # full URL
prbb acme/1691 --interval 60                  # poll every 60s (default 30s)
```

The `org/number` form finds the PR among your open PRs in that org; if the number matches PRs in
two repos, prbb asks for the explicit form.

While running, prbb prints one timestamped line per change:

```
[10:32:01] babysitting new-quest-ai/quest#1691
[10:32:02] checks:pending(3 running)  review:approved  merge:blocked  auto-merge:off
[10:32:02] enabled auto-merge (rebase)
[10:41:12] branch is behind main; rebasing via gh
[10:55:40] new-quest-ai/quest#1691 merged 🎉
```

## What it does — and doesn't

- Enables auto-merge using the repo's rebase method (falls back to squash, then merge commit).
- When the branch is behind its base, runs `gh pr update-branch --rebase` (GitHub's server-side
  rebase; never a local force push). Repeats at most every 2 minutes so GitHub can recalculate.
- Never bypasses protections, never uses admin merge, never merges drafts.
- Warns (⚠️/💬) when the PR still needs a review approval or has unresolved conversations.

It exits (with the codes below) instead of acting when the PR has a merge conflict, failing
checks, a "changes requested" review, is a draft, or was closed. Fix the problem and rerun.
Transient poll errors don't exit; prbb backs off and retries.

## Exit codes

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | PR merged                                                                      |
| 1    | generic failure                                                                |
| 2    | bad or ambiguous PR reference                                                  |
| 3    | `gh` authentication failure                                                    |
| 4    | merge conflict                                                                 |
| 5    | branch update failed                                                           |
| 6    | blocked (failing checks, changes requested, draft, or no allowed merge method) |
| 7    | PR closed without merging                                                      |

Errors print a single line to stderr; status lines go to stdout.

## Development

```sh
bun test              # all tests use a fake gh; nothing touches real PRs
bun run check         # typecheck
bun run fmt           # format
```

[src/gh.ts](src/gh.ts) is a small typed adapter around `gh`; [src/core/](src/core/) holds pure
parsing/status logic; [src/babysit.ts](src/babysit.ts) is the watch loop; [src/cli.ts](src/cli.ts)
wires it up.
