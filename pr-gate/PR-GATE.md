# The PR gate: run each check once, where it counts

One mechanism, in every beplus estate (bepluscloud/ai, every `beplus/*` library,
MRKIT, Mountaineer), that decides whether a pull request's checks run. Every
reusable workflow here takes it as `pr-gate: true`. A repository's own workflow
adds it as one job (see [Your own workflow](#your-own-workflow)).

## Why

Measured on bepluscloud/ai over 11 days (2026-11-05 to 11-16, every run):
console CI was 3,823 minutes of `checks`, about 13 minutes a run.

| What the run was on | Share of console minutes |
|---|---|
| a PR that changes the console, top of its stack or alone | 53% |
| a PR that changes the console, but **lower in a stack** | 29% |
| a PR lower in a stack that **does not touch the console** | 11% |
| a PR alone or on top that **does not touch the console** (desktop, docs) | 7% |

So about 47% ran for nothing. The library repositories had the opposite
problem: `ci.yml` ran on PRs into `dev` only, so a stack's bottom PR ran and its
top never did.

## The rules (PG-D1 to PG-D7; say if one is wrong)

- **PG-D1: A draft runs nothing.** Agents open drafts, test each branch locally,
  link the stack, then mark the PRs ready. `ready_for_review` starts the run.
- **PG-D2: In a stack, only the top PR runs.** Its head holds every change of the
  PRs below it, and a stack merges in one go (`gh stack merge`), so `dev` ends at
  the top's tree. A PR is "below" when another open PR (draft or not) is based on
  its branch. The checks a lower PR skips report "skipped", with the reason in
  the run's summary ("#681 is based on #680's branch…").
  - **What this gives up:** the commits between the bottom and the top of a
    stack are not each tested on `dev` (`git bisect` is coarser by a stack).
    Releases are cut from `dev`'s head, which is what the top tested.
  - **A PR merged on its own** (it leaves the stack, or the stack is merged part
    way) has nothing above it, so its next run is its own. It needs a run before
    it merges: push to it, or mark it ready again (`beplus gh pr ready <n> --undo`,
    then `beplus gh pr ready <n>`).
  - **Which PR broke it** is usually clear from the failing test. Otherwise run
    that suite on the lower branches locally, as every branch is tested before it
    is marked ready.
- **PG-D3: Only what the stack changes.** With `projects`, Rush's own
  `rush list --impacted-by git:<fork point>` decides. That covers dependencies
  between workspace projects and the lockfile, project by project: a lockfile
  change marks only the projects whose dependencies moved. With `paths`, a
  changed file matching one of the globs decides. Either one is enough.
- **PG-D4: The diff is the whole stack's.** It runs from where the stack left its
  root branch (`dev`, `main`, `_versions/…`): the gate follows each PR's base down
  while an open PR has that branch as its head. Never from the PR's own base,
  which for the top of a stack is the PR below it.
- **PG-D5: Files every build reads run everything** (`always`): workflows,
  `rush.json`, the root `package.json`, `beplus.estate.json`, Rush's config JSON
  and `.npmrc`, and `common/scripts/`. The lockfile is not among them, because
  Rush attributes it per project.
- **PG-D6: It fails open.** If GitHub cannot be asked (the caller did not grant
  `pull-requests: read`), or Rush cannot answer, the checks run, with a warning
  saying why. The gate never stops a check it could not reason about.
- **PG-D7: Skipped inside the workflow, never by `on.*.paths`.** A job skipped by
  `if:` reports "skipped", which a required check accepts. A workflow a `paths:`
  filter left out reports nothing, and a required check waits forever. A
  `paths:` filter also sees only the top PR's own commits, so with PG-D2 it
  would skip the one run that covers the stack. **Turning the gate on means
  removing the caller's `pull_request` `paths:`/`branches:` filter**, and
  passing the paths as `gate-paths` where the workflow takes them.

## Rolling it out

`pr-gate` is **off by default in every reusable workflow**, so moving `v2`
changes no caller. Each caller turns it on in one change:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]  # PG-D1
    # no `paths:` and no `branches:` (PG-D7)

permissions:
  contents: read
  pull-requests: read   # PG-D2: which PRs are based on this one

jobs:
  console:
    uses: beplus/setup-beplus/.github/workflows/app-ci.yml@v2
    with:
      project: "@bepluscloud/console"
      pr-gate: true          # draft, top of the stack, and @bepluscloud/console's impact
      # gate-paths: |        # instead of the project's impact, for a check that reads a few files
      #   packages/apps/console/app/*
```

| Workflow | What `pr-gate: true` decides by |
|---|---|
| `app-ci.yml` | draft, top-only, `project`'s Rush impact (or `gate-paths` instead) |
| `library-ci.yml` | draft, top-only. Claims the environment of the stack's root, not the PR's base |
| `docs-pages.yml` | draft, top-only, and `gate-paths` when given, for pull requests (a push builds and publishes as before) |
| `db-migrations-pr.yml` | draft, top-only, the database project's Rush impact (or `gate-paths` instead) |
| `infra-diff.yml` | draft, top-only with `gate-paths` (else every ready PR, as its `paths:` caller had it) |

A called workflow cannot ask for more than its caller grants, and asking fails
every caller that does not grant it. So none of these names
`pull-requests: read`. Where a workflow had a workflow-wide `permissions`, that
block moved to the jobs, and the gate's job takes the caller's token as it is.

## Your own workflow

```yaml
jobs:
  gate:
    runs-on: ubuntu-latest
    outputs:
      run: ${{ steps.gate.outputs.run }}
    steps:
      - id: gate
        uses: beplus/setup-beplus/pr-gate@v2
        with:
          projects: "@mcl/console"        # or paths:, or neither (draft + top-only)
  test:
    needs: gate
    if: needs.gate.outputs.run == 'true'
    # …
```

A job further down that `needs: test` and has an `if:` of its own must spell out
its status (`!cancelled() && needs.test.result == 'success' && …`). An implicit
`success()` treats a skipped job anywhere up the chain as not succeeded.

## The cache every PR reads

A cache is scoped to the ref that saved it. A PR reads its own, its base's and
the default branch's, never another PR's. Saving from a PR (about 40 s a run)
therefore served only that PR's next push. `app-ci.yml`, `library-ci.yml` and
`db-migrations-pr.yml` now **restore on a PR and save only off one**, and
[`rush-cache.yml`](../.github/workflows/rush-cache.yml) saves the one they all
read, from the default branch, under the key they restore.
