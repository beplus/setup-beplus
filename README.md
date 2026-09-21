# @beplus/setup-beplus

Composite GitHub Action collection for setting up the beplus Environment in GitHub Actions workflows.

---

## Available Actions

### [`cli`](./cli/README.md)
Installs the beplus CLI (`@beplus/be` and `beplus`) with optional npm authentication.

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_CLI_VERSION: latest
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
# .github/workflows/publish.yml — keep your own triggers, share the pipeline
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
checks that, resolving each caller against the shared workflow and comparing the
enabled steps to the file it replaced.

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

      - uses: beplus/setup-beplus/cli@v2
        with:
          BE_CLI_VERSION: latest

      - uses: beplus/setup-beplus/git@v2

      - run: beplus --version
```

---

## Documentation

See each action's README for detailed configuration options, prerequisites, and troubleshooting:

- [beplus CLI Action](./cli/README.md)
- [beplus Git Action](./git/README.md)
