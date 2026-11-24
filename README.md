# @beplus/setup-beplus

Composite GitHub Action collection for setting up the beplus Environment in GitHub Actions workflows.

---

## Available Actions

### [`cli`](./cli/README.md)
Installs the beplus CLI (`@beplus/be` and `beplus`) with optional npm authentication —
the version the repository pins in `beplus.estate.json` → `cli.version` (`be auto`).
A repository without a pin gets `latest` and a warning that it floats; see
[Pinning the CLI](./cli/README.md#pinning-the-cli). `BE_CLI_PLUGINS` installs CLI
plugins the CLI does not bundle, each at an exact version; see
[Plugins](./cli/README.md#plugins).

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

### [`pr-gate`](./pr-gate/PR-GATE.md)
Decides whether a pull request's checks run: never on a draft, only on the top PR
of a stack (its tree holds every PR below it), and only when the stack impacts the
Rush projects (or changes the paths) the check reads. Every reusable workflow below
takes it as `pr-gate: true`, off by default. See [PR-GATE.md](./pr-gate/PR-GATE.md).

```yaml
- id: gate
  uses: beplus/setup-beplus/pr-gate@v2
  with:
    projects: "@bepluscloud/console"
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

#### Tests in library-ci

`library-ci.yml` builds every project (`rush rebuild`) and, with **`tests: true`**
(since v2.18.0), runs the repository's bulk `test` command after it:
`rush test --verbose`, over every project, as the build is (the job's PR gate
selects no projects, so there is no impacted set to narrow to). A repository whose
`common/config/rush/command-line.json` has no bulk `test` command gets a notice
and a line in the job summary saying no tests ran, and the step passes. Until
v2.18.0 the step only echoed "Tests will be added in the future", so a library
without a `test` job of its own ran its tests on developers' machines only.

It is off by default, because the libraries that already had a bulk `test` run it
in a `test` job of their own (actions, ai, i18n, kb, mind, flows, workbench, …),
several against a Postgres or Neo4j service that this job does not start. Turn it
on in a library that has no such job:

```yaml
    uses: beplus/setup-beplus/.github/workflows/library-ci.yml@v2
    with:
      packages: |
        packages/core/api-core
      tests: true
```

A project without a `test` script is skipped only if the command says
`"ignoreMissingScript": true`; give a project that needs tools the runner lacks
(the Smithy CLI, say) no `test` script, or a separate one.

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
- **"Latest" on GitHub** is one release: the version prod promoted of the package
  `latest-release` names, else of the repository's only package, else of the one named
  after the repository (`@beplus/cdk` in beplus/cdk). With none of them, prod leaves the
  badge alone. It is set on every prod promotion, so it always matches prod's `latest`.
- **Dist-tags.** Each CodeArtifact is its environment's own registry, so a promoted
  version becomes its `latest`: what an install in that environment gets. The
  earlier versions go out first, under a temporary `catch-up` tag, so `latest` never
  moves back. Removing that tag needs `codeartifact:PutPackageMetadata` on the
  `npm-publishing` role; a tag a run could not remove goes on the next one. GitHub
  Packages is the one registry every environment shares, so its tags show how far a
  version got.
- **The repository's docs package goes the same way.** docs-pages.yml publishes
  its portal as `@<owner>/<site id>-docs` to GitHub Packages and dev's CodeArtifact,
  recording the commit it was built from (`gitHead`). A promotion carries the newest
  version whose commit that branch holds, and every earlier one the environment
  lacks, with the libraries. The name comes from `packages/sites/*/docs.config.*`'s
  `site.id`; a repository with no portal promotes its libraries alone.
- **A repository with no library here** (its libraries release another way, as
  cli_v2's do, or it has none) still promotes its docs package: its publish
  workflow triggers on `stage` and `prod` only and calls this with
  `libraries: false`, `packages: ""`, `publish-to: ""` and
  `force-change-files: false`.
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
- the role `github-actions-<owner>-<repo>-<env>-npm-publishing` in that account (`<owner>` is the
  repository's: `beplus` for beplus/*, `bepluscloud` for bepluscloud/*).

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

An estate's application gets **`app-ci.yml`**: its own type check and tests on a
pull request, and its integration suites against a real Postgres with every
migration chain applied. `library-ci.yml` is a library's gate (change files,
version policies, bundle sizes); no estate ran an app's tests in CI at all.

- **plan** reads the project's folder from `rush.json` (the `projectFolder` of the
  `project` input) and, with `postgres`, the test database's name the way
  db-migrations-pr.yml does (`naming.prefix` + `_test`).
- **checks** sets up Node, installs the pinned CLI, runs `beplus npm auth` with the
  stub-200 registry check over the project's `@beplus` dependencies, then
  `rush install --to <project>` and `rush build --to-except <project>`.
- **With `postgres`** it starts `pgvector/pgvector:0.8.7-pg16`, points
  `BE_POSTGRES_URL` at it, and runs `beplus db migrate`: the repository's own
  migrator declaration, every embedded chain included, as a container migrates at
  start.
- Then `setup` runs, one command per line, stopping at the first failure. Then
  **every** line of `checks` runs, in the project's folder, even after one has
  failed. The job fails if any did; each failure is an annotation, and the job
  summary lists every check with its result and time.

```yaml
# .github/workflows/console-ci.yml — keep your own triggers
name: console CI
on:
  pull_request:
    branches: [dev]
permissions:
  contents: read
concurrency:
  group: console-ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  console:
    uses: beplus/setup-beplus/.github/workflows/app-ci.yml@v2
    with:
      project: "@bepluscloud/console"
      github-environment: dev   # only where BE_NPM_TOKEN is an environment secret
      postgres: true
      setup: |
        npx react-router typegen
      checks: |
        npm run typecheck
        npx vitest run --exclude "**/*.integration.test.ts"
        npx vitest run .integration.test.ts
    secrets: inherit
```

| Input | Default | |
|---|---|---|
| `project` | required | The Rush project; its folder is where `setup` and `checks` run |
| `checks` | required | One command per line; every one runs |
| `setup` | none | One command per line, before the checks; the first failure stops the job |
| `postgres` | `false` | The pgvector service, `BE_POSTGRES_URL`, and (`migrate`) the migrations |
| `migrate` | `true` | With `postgres`: `beplus db migrate` against the service |
| `build` | `dependencies` | `dependencies` (`--to-except`), `project` (`--to`) or `none` |
| `working-directory` | the project's folder | Where `setup` and `checks` run |
| `github-environment` | none | The environment holding `BE_NPM_TOKEN` (bepluscloud, MRKIT: `dev`) |
| `node-version` | `22.14` | |
| `timeout-minutes` | `40` | The checks job's |

The check is named `<caller job> / checks` (`console / checks`). It reaches no
database but its own service, reads no connection secret and assumes no AWS
role. A caller without a `paths` filter can make it a required status check.

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

After a publish, the `package` job also publishes the site as a **docs package**
(`beplus-docs package`, `beplus-docs/package@1`): every rendered page, the
search index, the files the pages point at and the release bundle's Markdown,
as `@beplus/<site id>-docs@1.0.0-dev.<UTC time>`. It goes out as a library's
version does: GitHub Packages first (dist-tag `dev`), then the CodeArtifact of
`package-environment` (`dev`, dist-tag `latest`), with the commit it was built
from as its `gitHead`. stage and prod get it from the repository's promotion
(library-publish.yml), once their branch holds that commit. bepluscloud's console
pins these packages for its Products, and the desktop's Library reads them. The
job runs in that GitHub environment and assumes the repository's npm-publishing
role, the one its library releases use. Without a role it says so in the
summary, and the site deploys all the same. `package: false` turns it off;
`docs-build-version` picks the `@beplus/docs-build` that packs (`latest`).

⚠️ **The caller grants `packages: write`** to the job that calls docs-pages.yml,
for GitHub Packages, as its publish workflow does. A caller that does not cannot
start the workflow at all, its Pages deploy included: grant it before moving `v2`
past a docs-pages.yml that asks for it.

To retire a site, set `redirect-to` to where its pages now live
(`https://app.beplus.cloud/products/beplus/<id>/docs/`). The build runs as
before and still publishes the docs package, but Pages then serves a page per
route that sends the reader to the same route there, and a 404 that sends any
other path the same way.

What an agent reads of that site goes onto the package's GitHub release too:
`docs-bundle.yml` packs the build into `docs-bundle.tgz` (`beplus-docs pack`,
the `beplus-docs/release-bundle@1` contract) and attaches it, where bepluscloud's
`beplus-knowledge` App and the local `beplus kb` read it as a knowledge Area —
the Pages site itself is private. It is one more job in the publish workflow,
after `library-publish`:

```yaml
# .github/workflows/publish.yml
jobs:
  publish:
    uses: beplus/setup-beplus/.github/workflows/library-publish.yml@v2
    # … as it is
  docs-bundle:
    needs: publish
    if: github.ref_name == 'dev'
    uses: beplus/setup-beplus/.github/workflows/docs-bundle.yml@v2
    permissions:
      contents: write
      pages: read
    secrets: inherit
    with:
      working-directory: packages/sites/portal
      package: packages/core/cli # the package whose release carries the bundle
      prebuild: node common/scripts/install-run-rush.js build --to @beplus/cli
```

- **A job, not `on: release`.** library-publish creates its releases with
  `GITHUB_TOKEN`, and an event that token causes starts no workflow.
- **On dev only.** The releases are made there; stage and prod promote them, and
  keep their assets.
- **The release is found, not passed:** the tag of `package`'s newest
  `CHANGELOG.json` entry on the branch. The site is built from that tag, so the
  bundle is the release's even when dev has moved on.
- **Once per release.** A release that has no GitHub release, or already carries
  `docs-bundle.tgz`, is left alone (`overwrite: true` replaces it), so a push that
  released nothing does nothing. It warns when the site's `site.version` is not
  the released version.
- **Backfill** an earlier release with `tag`, e.g. `tag: "@beplus/cli_v2.11.0"`
  from a `workflow_dispatch` caller — built from that tag, so its portal must
  already have `pack`.

The other inputs are docs-pages.yml's: `build`, `output`, `environment` and
`node-version`. It needs `@beplus/docs-site >= 1.0.0-next.19` (beplus/docs#31).

An estate's desktop app — an Electron shell over its deployed console
(bepluscloud's beplus app, Mountaineer's, MRKIT's) — is released for macOS,
Windows and Linux by **`desktop-release.yml`**. bepluscloud released all three
from one tag; the other two carried a Mac-only copy of its first half that
differed by names alone. Those names are the inputs (BE-281, under I-34):

```yaml
# .github/workflows/desktop-release.yml — keep your own triggers
name: Desktop Release
on:
  push:
    tags: ["mountaineer/desktop/v*"]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
concurrency:
  group: desktop-release
  cancel-in-progress: false
jobs:
  release:
    uses: beplus/setup-beplus/.github/workflows/desktop-release.yml@v2
    with:
      app-dir: packages/apps/desktop
      project: "@mountaineer/desktop"
      product: Mountaineer
      tag-prefix: mountaineer/desktop/v
      feed-url: https://desktop.mountaineer.im/mountaineer
      release-role: arn:aws:iam::270953801504:role/github-actions-ironmountain-cz-monorepo-main-desktop-release
      release-bucket: be-desktop-releases-270953801504
      s3-prefix: mountaineer
      environment: shared
      windows: ${{ vars.BE_DESKTOP_WINDOWS }}
      linux: ${{ vars.BE_DESKTOP_LINUX }}
      npm-target: ${{ vars.BE_NPM_TARGET }}
    secrets: # every one, by name, whatever level it lives at
      BE_NPM_TOKEN: ${{ secrets.BE_NPM_TOKEN }}
      BE_GITHUB_APP_ID: ${{ secrets.BE_GITHUB_APP_ID }}
      BE_GITHUB_APP_PRIVATE_KEY: ${{ secrets.BE_GITHUB_APP_PRIVATE_KEY }}
      BE_APPSTORE_CONNECT_KEY_ID: ${{ secrets.BE_APPSTORE_CONNECT_KEY_ID }}
      BE_APPSTORE_CONNECT_KEY_ISSUER_ID: ${{ secrets.BE_APPSTORE_CONNECT_KEY_ISSUER_ID }}
      BE_APPSTORE_CONNECT_KEY_CONTENT: ${{ secrets.BE_APPSTORE_CONNECT_KEY_CONTENT }}
      BE_FASTLANE_MATCH_PASSWORD: ${{ secrets.BE_FASTLANE_MATCH_PASSWORD }}
      AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
      AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
      AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
```

Every estate's caller is this file, with its own `with:` values: bepluscloud's,
Mountaineer's and MRKIT's differ in nothing else.

- **plan** reads `app-dir`'s package.json version, refuses a tag that is not
  `<tag-prefix><version>`, and decides which platforms build.
- **build-mac** (on a tag) claims `environment` for its secrets and builds both
  architectures in one electron-builder run, signed and notarized through the
  package's fastlane `build` lane, from the match store `signing-repo`
  (beplus/apple-signing by default). Then it checks the
  signature, Gatekeeper and the staple, and smoke-tests the packaged app.
- **build-windows** (when `windows` is `unsigned` or `signed`) builds one NSIS
  installer for x64 and arm64. `signed` goes through Azure Trusted Signing
  (`BE_WIN_SIGNING_*`, `AZURE_*`). `unsigned` checks that the pack names no
  publisher, so its copies take the first signed update.
- **check-windows** (after build-windows, on ubuntu) runs `beplus electron
  check win` on the Windows pack. The beplus CLI cannot be set up on a Windows
  runner yet (`be` has no Windows build), so build-windows hands the two exes,
  the installer and latest.yml over as the artifact `windows-pack`.
- **build-linux** (when `linux` is `on`) builds a .deb and an AppImage for x64
  and arm64 on ubuntu-22.04, writes `SHA256SUMS-<version>-linux.txt`, and
  smoke-tests the AppImage and the installed .deb under Xvfb.
- **publish** (on a tag) claims **no** environment, because the release role
  trusts the tag's subject. It refuses a version already in the bucket, uploads
  the installers immutable and then each platform's manifest uncached, and reads
  the feed back.
- **Run workflow** (any branch) packs Windows unsigned and Linux for a try,
  keeps them as the run's artifacts `windows-try` and `linux-try`, and
  publishes nothing.

After each pack, **`beplus electron check mac|win|linux`** checks it: the
Electron fuses, both architectures, the installers and manifests, the .debs'
insides, and the Windows and Linux icons (the rounded tile). That is
[`@beplus/cli-plugin-electron`](https://github.com/beplus/desktop/tree/dev/packages/cli/plugin-electron),
one copy for every estate (BE-281). The CLI does not bundle it, so each job
installs it with the [`cli`](./cli/README.md#plugins) action's `BE_CLI_PLUGINS`, at
the exact version the workflow names (`BE_ELECTRON_PLUGIN`). A setup-beplus
release moves that version, so a caller changes nothing. The same plugin draws
an app's icons from its artwork (`beplus electron icons`), and
`beplus docs show electron` is its guide.

What the app must provide: `bundle exec fastlane build` for the Mac, the npm
scripts `dist:win`, `dist:win:local` and `dist:linux`, and a packer that writes
`BE_DESKTOP_UPDATE_URL` into app-update.yml. The check reads its names from
electron-builder.yml: `productName`, `linux.executableName`, a `protocols`
scheme, `win.icon` and `linux.icon`, and package.json's `desktopName` (fpm also
wants `homepage` for the .deb). The file names are electron-builder's
defaults for the Mac; `nsis.artifactName` is `<product>-Setup-${version}.${ext}`,
`appImage.artifactName` is `<product>-${version}-${arch}.${ext}`, and
`deb.artifactName` is `<product>_${version}_${arch}.${ext}`, which installs to
`/opt/<product>/<executable>`. A smoke run (`BE_DESKTOP_SMOKE=1`) prints a JSON line
last, holding `"smoke":"ok"` and `"version":"<version>"`.

| Input | Default | |
|---|---|---|
| `app-dir`, `project`, `product` | required | The package's folder, its Rush project, electron-builder's productName (no spaces) |
| `executable` | `product`, lower case | `linux.executableName` |
| `tag-prefix`, `feed-url` | required | The tag without its version; the feed installed copies read |
| `release-role`, `release-bucket`, `s3-prefix` | required | publish's role, the feed's bucket, and the key prefix the feed's path serves |
| `environment` | required | The GitHub environment holding the build secrets (`shared`, `main`) |
| `signing-repo` | `beplus/apple-signing` | The fastlane match store, as owner/name (MRKIT: `mrkithq/apple-signing`) |
| `mac` | `true` | Build and publish the Mac on a tag |
| `windows` | none | `unsigned` or `signed`; pass `vars.BE_DESKTOP_WINDOWS` |
| `linux` | none | `on`; pass `vars.BE_DESKTOP_LINUX` |
| `npm-target` | `beplus.cloud` | npm.<target>; pass `vars.BE_NPM_TARGET` |
| `test`, `test-windows`, `test-linux` | `npm test` | The tests in `app-dir` per platform |
| `linux-apt` | none | Extra apt packages for the Linux job |
| `linux-check` | none | More checks of the installed x64 .deb after its smoke run (the beplus app: its Terminal) |
| `build-env` | none | `KEY=VALUE` lines for every pack and smoke run (not secrets) |
| `smoke-match` | none | A string the smoke line must also hold (e.g. the console's origin) |
| `node-version`, `aws-region` | `22.14`, `us-east-1` | |

Secrets go **by name**, all ten of them as above, because GitHub passes
`inherit` only to a workflow of the same organization or enterprise. A
repository's or an organization's secret reaches the workflow only through the
caller's `secrets:` block; one the block leaves out arrives empty (Mountaineer's
and MRKIT's first tags failed that way: `BE_APPSTORE_CONNECT_KEY_CONTENT isn't
set`). A secret in `environment` is read by the jobs that claim it and wins over
a passed one. build-mac checks its seven secrets before it builds, and
build-windows its npm token (and `AZURE_*` for a signed release), naming each one
that is empty.

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
