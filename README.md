# @beplus/setup-beplus

Composite GitHub Action collection for setting up the beplus Environment in GitHub Actions workflows.

---

## Available Actions

### [`cli`](./cli/README.md)
Installs the beplus CLI (`@beplus/be` and `beplus`) with optional npm authentication —
the version the repository pins in `beplus.estate.json` → `cli.version` (`be auto`).
A repository without a pin gets `latest` and a warning that it floats; see
[Pinning the CLI](./cli/README.md#pinning-the-cli).

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_NPM_AUTH: false
```

### [`setup-git`](./git/README.md)
Configures Git for secure operations using a GitHub App token.

```yaml
- uses: beplus/setup-beplus/git@v2
```
### Reusable workflows

The thirteen `beplus/*` library repositories each carried a copy of the same PR
check and the same publish pipeline — 6,836 lines that differed, in most of them,
by the package list alone. Both now live here once:

```yaml
# .github/workflows/ci.yml
jobs:
  validate:
    uses: beplus/setup-beplus/.github/workflows/library-ci.yml@v2
    secrets: inherit
    with:
      packages: |
        packages/core/docs
```

```yaml
# .github/workflows/publish.yml — dev releases, stage and prod promote
on:
  push:
    branches: [dev, stage, prod] # no `paths`: see "No paths filter" below
jobs:
  publish:
    uses: beplus/setup-beplus/.github/workflows/library-publish.yml@v2
    secrets: inherit
    with:
      packages: |
        packages/core/docs
      publish-to: "--to @beplus/docs"
      force-change-files: true
```

Every optional step is an input that defaults to OFF, so adopting these changes
nothing: a repository states what it already did. `scripts/verify-callers.mjs`
checked that, resolving each caller against the shared workflow and comparing the
enabled steps to the file it replaced.

#### One version per commit, built once, promoted

A library publishes the way cli_v2 releases the CLI. A version is cut once, on dev,
and stage and prod publish those same bytes — never a build of their own:

| Branch | The run | Its CodeArtifact | GitHub Packages | GitHub releases |
|---|---|---|---|---|
| `dev` | versions and packs once; commits, tags, pushes; then GitHub Packages first, then dev's CodeArtifact | `latest` | `dev` | pre-releases |
| `stage` | builds nothing: publishes the tarballs dev published, fetched from GitHub Packages | `latest` | `stage` | — |
| `prod` | the same, for prod | `latest` | `latest` | full releases |

- **stage and prod promote the versions their commit carries.** Fast-forward them to
  a commit dev released. A version GitHub Packages does not have is refused.
- **And every version before it.** A fast-forward promotes the commits in between
  too, so each promotion also publishes every earlier version dev released that
  the environment's CodeArtifact lacks: release on dev as often as you like and
  promote when you are ready, and stage and prod still end up with every version,
  so a lockfile that pinned one on dev installs there too. "Earlier" is semver, up
  to the commit's own version; dev's newer releases wait for their own promotion.
  A version the registry refuses (one archived there on purpose) is a warning, not
  a failed run, and the next promotion tries it again. prod makes each one's GitHub
  release a full release; none of them takes "Latest" from the newest.
- **Dist-tags.** Each CodeArtifact is its environment's own registry, so a promoted
  version becomes its `latest`: what an install in that environment gets. The
  earlier versions go out first, under a temporary `catch-up` tag, so `latest` never
  moves back. Removing that tag needs `codeartifact:PutPackageMetadata` on the
  `npm-publishing` role; a tag a run could not remove goes on the next one. GitHub
  Packages is the one registry every environment shares, so its tags show how far a
  version got.
- **No `[skip ci]` on the version commit.** GitHub skips a push whose head commit
  says `[skip ci]`, and stage and prod fast-forward to exactly that commit. The dev
  run skips the version commit by its message instead.
- **Pushed before published.** A dev run releases dev as it is when the run starts,
  and pushes its version commit and tags, atomically, before either registry sees a
  version. If something is merged to dev while it builds, the push is rejected and
  nothing is published; the run that merge started (queued behind this one) releases
  both.
- **Every version gets a changelog entry, a tag and a release.** Rush writes no
  changelog for a prerelease (`0.1.0-next.N`), so the workflow writes the entry
  from the change files and deletes them, as Rush does for a final version.
- **No `paths` filter.** A caller triggers on every push to the three branches. GitHub
  matches `paths` against the first 300 changed files only, and a promotion's diff
  has no change file (the version commit deletes them), so a filter could keep a
  push to stage or prod from promoting anything. On dev, the `plan` job does the
  filter's work instead: it checks out only `common/changes` and decides in seconds
  whether there is anything to release (force, change files, or dev on a version
  commit), so a push with nothing to release never installs or builds.
- **Other branches.** The workflow does nothing on any branch but these three.
- **`promote`** is how a caller opted in while the older per-environment pipeline
  still existed. It is ignored now; drop it when you next touch the caller.

`stage` and `prod` each need, as `dev` does:
- a GitHub environment with the variables `BE_ENVIRONMENT` and `BE_AWS_ACCOUNT_ID`;
- the role `github-actions-beplus-<repo>-<env>-npm-publishing` in that account.

They install nothing, so they need no `BE_NPM_TOKEN`.

An estate's pull-request `cdk diff` — one sticky comment per CDK app — is one more.
The three estates carried a 186-line copy each; the role, the region and the
comment marker were the only differences, and all three are derived (the role
`github-actions-<owner>-<repo>-<env>-cdk-diff` from the calling repository, the
region from `beplus.estate.json` → `defaultRegion`, the marker from `naming.product`),
so it has no inputs. The trigger, the permissions and the concurrency group stay
in the repository:

```yaml
# .github/workflows/infra-diff.yml
name: infra diff
on:
  pull_request:
    paths:
      - "packages/aws/**"
      - "packages/apps/<app>/.bepluscloud/**"
      - ".github/workflows/infra-diff.yml"
      - "beplus.estate.json"
permissions:
  id-token: write
  contents: read
  pull-requests: write
concurrency:
  group: infra-diff-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  infra-diff:
    uses: beplus/setup-beplus/.github/workflows/infra-diff.yml@v2
    secrets: inherit
```

It cannot deploy: the composite always runs in `mode: diff` as the read-only
`…-cdk-diff` role, and nothing a caller passes can change either. It installs the
CLI the repository pins (`cli.version`). `node scripts/verify-callers.mjs infra-diff
--repo <estate>` proves a caller plus this workflow reproduce the file it replaced,
step for step.

An estate's database gates are two more. MRKIT and Mountaineer each carried
`db-migrations-pr.yml` (146 / 137 lines) and `db-drift-env.yml` (105 / 91);
bepluscloud had neither. Both now run the repository's own `beplus db` commands —
`@beplus/database-tools`, resolved from the repository's install, never bundled
in the CLI — over `beplus.estate.json`'s `database` section:

- **`db-migrations-pr.yml`** — on a pull request: a pgvector Postgres service
  (`pgvector/pgvector:0.8.7-pg16`), the pinned CLI, `beplus npm auth` with the
  stub-200 registry check (`BE_NPM_CHECK`, below), `rush install` / `rush build
  --to <the database project>`, then `beplus db check`, `db check pending`,
  `db check chains` and `db check rebuild --compare`. It reaches no database but
  its own service.
- **`db-drift-env.yml`** — nightly and on demand: `beplus db diff migrations
  <env>` for each environment, then each environment against the next, all
  aggregated so one drift does not hide another. Connection strings are the
  secrets `BE_POSTGRES_URL_DEV` / `_STAGE` / `_PROD`, as before; there is no
  database-read OIDC role in any account yet, nor a `db diff` through the tunnel,
  so it assumes no AWS role.

The rush project (`database.package` → its package.json `name`), the test
database (`naming.prefix` + `_test`) and the environments (`environments`) come
from the manifest; the inputs are for what cannot:

| Input | Workflow | Default | |
|---|---|---|---|
| `github-environment` | both | none | The GitHub environment the job claims, when `BE_NPM_TOKEN` (and the connection strings) are environment secrets there — MRKIT: `dev` |
| `environments` | drift | `beplus.estate.json` → `environments` | e.g. `dev prod`; dev, stage and prod are mapped |
| `project` | both | `database.package`'s package.json `name` | The Rush project to install (and build) |

```yaml
# .github/workflows/db-migrations-pr.yml — keep your own triggers
name: DB Migrations (PR-safe)
on:
  pull_request:
    paths:
      - "packages/modules/database/drizzle/**"
      - ".github/workflows/db-migrations-pr.yml"
      # … the schema sources, drizzle.config.ts, package.json
permissions:
  contents: read
concurrency:
  group: db-migrations-pr-${{ github.workflow }}-${{ github.head_ref || github.ref }}
  cancel-in-progress: true
jobs:
  checks:
    uses: beplus/setup-beplus/.github/workflows/db-migrations-pr.yml@v2
    secrets: inherit
```

```yaml
# .github/workflows/db-drift-env.yml
name: DB Drift (dev/prod)
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * *"
permissions:
  contents: read
concurrency:
  group: db-drift-env-${{ github.workflow }}
  cancel-in-progress: false
jobs:
  drift:
    uses: beplus/setup-beplus/.github/workflows/db-drift-env.yml@v2
    secrets: inherit
```

Keep the job ids (`checks`, `drift`): the check is then named
`checks / migration integrity + rebuild` — a required status check that named
`migration integrity + rebuild` has to be renamed once. The pinned CLI must bundle
`@beplus/cli-plugin-database` with `db check pending | rebuild | chains` and the
repository must have installed `@beplus/database-tools`; `beplus db` refuses
cleanly otherwise. `node scripts/verify-callers.mjs db --repo <estate>` proves a
caller plus these workflows reproduce the files it replaced: it runs the shared
plan step on the estate's own manifest, compares every job and step, and runs the
drift job's rewritten guard and comparison side by side with the copies'.

A repository's docs site — `@beplus/docs-site` from beplus/docs — is built and
published to GitHub Pages by one more:

```yaml
# .github/workflows/docs.yml — keep your own triggers
jobs:
  docs:
    uses: beplus/setup-beplus/.github/workflows/docs-pages.yml@v2
    permissions:
      contents: read
      pages: write
      id-token: write
    secrets: inherit
    with:
      working-directory: packages/sites/portal
      prebuild: node common/scripts/install-run-rush.js build --to @beplus/cli
      publish-branch: prod
```

It asks Pages where the site lives (`DOCS_BASE`, `DOCS_SITE_URL`), builds, and
publishes on a push to `publish-branch`; a pull request builds and stops.

It also asks GitHub which beplus projects publish a portal, for the site's
project switcher (`DOCS_PROJECTS`): every repository with the org's
`beplus-docs-project` custom property set, at its Pages address. That reads the
other repositories with the org's `beplus` App — `BE_GITHUB_APP_ID` (variable)
and `BE_GITHUB_APP_PRIVATE_KEY` (secret), with Metadata, Pages and custom
properties read. Without them the site shows the engine's own list.

---

## Quick Start

```yaml
name: Example Workflow

on: push

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # The version pinned in beplus.estate.json → cli.version
      - uses: beplus/setup-beplus/cli@v2

      - uses: beplus/setup-beplus/git@v2

      - run: beplus --version
```

---

## Documentation

See each action's README for detailed configuration options, prerequisites, and troubleshooting:

- [beplus CLI Action](./cli/README.md)
- [beplus Git Action](./git/README.md)
