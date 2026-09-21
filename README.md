# prbb

Babysits your GitHub pull requests. Watches checks, reviews, and mergeability; keeps ready PRs
moving by updating branches and enabling auto-merge; hands merge conflicts to a Herdr agent.

All GitHub access goes through the installed `gh` CLI and its login. prbb never stores tokens.

## Install

```sh
bun install
bun link          # makes `prbb` available on PATH
```

Requires [Bun](https://bun.sh) and an authenticated [`gh`](https://cli.github.com) (`gh auth login`).

## Interactive use

```sh
prbb <org>            # live TUI: your open non-draft PRs in that organization
prbb --all            # every organization
prbb <org> --drafts   # include drafts (shown, never auto-merged)
prbb <org> --watch-only  # watch and report; never writes to GitHub
prbb <org> --interval 60 # poll every 60s (default 30s, backs off on errors)
```

An organization (or user) is required unless you pass `--all`. The filter also applies to
manually added PRs, so the screen stays org-scoped.

One row per PR: repo#number, title, checks, review, merge state, auto-merge state, last refresh.
The activity area below shows polling, actions, failures, and merges as they happen.

### Keys

| Key                | Action                                                        |
| ------------------ | ------------------------------------------------------------- |
| `↑`/`↓` or `j`/`k` | select PR                                                     |
| `r`                | refresh now                                                   |
| `o`                | open selected PR in browser                                   |
| `c`                | start a Herdr conflict-resolution agent (conflicting PR only) |
| `?` or `h`         | toggle help                                                   |
| `q` / Ctrl-C       | quit                                                          |

Add and remove tracked PRs from the shell (the TUI picks changes up on the next poll):

```sh
prbb add https://github.com/acme/widgets/pull/42
prbb add acme/widgets#42
prbb add 42 --repo acme/widgets     # or run inside a checkout of the repo
prbb remove acme/widgets#42         # stops tracking; also hides it from discovery
```

A bare number outside a GitHub repo without `--repo` is an error (exit code 2).

## Agent / machine use

Machine output goes to stdout; diagnostics go to stderr. No ANSI, no prompts.

```sh
prbb status <org> --json  # one snapshot: every PR's status plus the planned next action
prbb watch <org>          # JSONL: one event per line (pr-updated, action, conflict, merged, …)
prbb config-path      # print config file location
```

Structured errors print one JSON line to stderr: `{"error":{"code":"…","message":"…"}}`.

### Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | success                                            |
| 1    | generic failure                                    |
| 2    | usage error (for example ambiguous bare PR number) |
| 3    | `gh` authentication failure                        |
| 4    | merge conflict that needs Herdr                    |
| 5    | branch update failed                               |
| 6    | blocked by checks or reviews                       |
| 7    | PR already merged or closed                        |

## What prbb does on its own

Unless `--watch-only` is set, prbb automatically:

- **Enables auto-merge** on open, non-draft PRs whose checks aren't failing and that have no
  "changes requested" review. It prefers the repository's rebase method, falling back to squash,
  then merge commit.
- **Updates branches** that are behind their base, using GitHub's update-branch (a merge from
  base — never a force push).

Every action is announced in the activity log / JSONL stream. Repeated actions on the same PR are
rate-limited (5 min cooldown) so GitHub has time to recalculate checks and mergeability.

prbb never: bypasses branch protections, uses admin merge, merges drafts, force-pushes, or
auto-merges a stacked PR. When one tracked PR's base is another tracked PR's head branch, prbb
treats it as a stack layer and reports the required merge order instead of acting.

## Conflicts and Herdr

When GitHub reports a conflict, the PR row shows `‼ CONFLICT` and the activity log prompts you to
press `c`. Inside Herdr (`HERDR_ENV=1`), that creates or reuses a Worktrunk worktree for the PR
branch, opens a Herdr workspace, and starts a Pi shipmate with a focused conflict-resolution task.
An existing conflict workspace for the same PR is reused, never duplicated.

Outside Herdr, prbb fails with exit code 4 and instructions to rerun inside Herdr. prbb never
resolves conflicts itself.

To find the local checkout for a repo, prbb tries `repoPaths["owner/repo"]` from the config, then
`~/code/<repo>`.

## Config

Stored at `$XDG_CONFIG_HOME/prbb/config.json` (default `~/.config/prbb/config.json`; override with
`PRBB_CONFIG_DIR`):

```json
{
  "manualPrs": [{ "owner": "acme", "repo": "widgets", "number": 42 }],
  "ignoredPrs": [],
  "repoPaths": { "acme/widgets": "/Users/joel/code/widgets" }
}
```

## Development

```sh
bun test              # unit/integration tests (fake gh/wt/herdr; never touches real PRs)
bun run check         # typecheck
bun run fmt           # format
```

Layout follows small typed adapters: [src/gh.ts](src/gh.ts) wraps `gh`, [src/core/](src/core/)
holds pure parsing/status/planning logic, [src/engine.ts](src/engine.ts) runs the poll loop, and
[src/tui/](src/tui/) renders it with Ink.
