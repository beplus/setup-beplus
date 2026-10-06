# Setup beplus CLI (GitHub Action)

Composite GitHub Action that installs [@beplus/be](https://github.com/beplus/be) and then installs the [**beplus CLI**](https://github.com/beplus/cli) (`beplus`) into a **writable prefix** (no `sudo` required) — by default **the version the repository pins** in `beplus.estate.json`. Optionally runs `beplus npm auth` for [beplus.cloud](https://beplus.cloud) package access.

---

## What it does

1. Installs `be` using the official install script
2. Chooses the version:
   - `BE_CLI_VERSION` set → `be <BE_CLI_VERSION>` (wins over a pin, with a warning when it differs from it)
   - otherwise, the nearest `beplus.estate.json` has `cli.version` → `be auto`, which installs exactly that version
   - otherwise → `be latest`, as before, with a `::warning::` that the repository floats
3. Verifies `beplus --version` — and, for a pinned run, fails unless it is exactly the pinned version
4. Optionally runs `beplus npm auth` if enabled and required environment variables are present

---

## Inputs

| Input | Required | Default | Description |
|------|----------|---------|-------------|
| `BE_CLI_VERSION` | No | empty | Version or channel of beplus CLI to install (passed to `be`). Empty installs the repository's pin (`be auto`), or `latest` with a warning when there is none. A value here wins over the pin. |
| `BE_NPM_AUTH` | No | `false` | If `true`, runs `beplus npm auth` |
| `BE_PREFIX` | No | empty | Install prefix for beplus binaries. If empty, defaults to `$HOME/.beplus`. Must be writable. |
| `BE_WORKING_DIRECTORY` | No | the workspace | Where the pin is looked up: the nearest `beplus.estate.json` at or above this directory, exactly as `be auto` finds it. Relative to the workspace. |

---

## Pinning the CLI

A CLI release must never change what a repository's CI does without a commit in
that repository. So the repository commits the version it runs, in
`beplus.estate.json` at its root:

```json
{
  "cli": { "version": "2.11.0" }
}
```

`version` is an exact version (`2.11.0`, not `2` or `latest`). With it, this
action runs `be auto` — the same command a laptop, a Docker build stage or a
buildspec runs, so every place resolves the pin the same way — and then checks
`beplus --version` against it. An inexact or unreadable pin fails the run; it
never falls back to `latest`.

Check the repository out **before** this action, or there is no manifest to read
(and the run floats, with a warning). In a monorepo the nearest manifest at or
above `BE_WORKING_DIRECTORY` wins.

[`cdk-package`](../cdk-package/action.yml) installs the CLI through this action
with an empty `cli-version` by default, so it honours the pin too.
[`test-cli.yml`](../.github/workflows/test-cli.yml) proves all of this on every
change, against the fixtures in [`test/cli`](../test/cli).

### Bumping the pin

One commit per repository, nothing else in it:

1. Change `cli.version` in `beplus.estate.json` (e.g. `2.11.0` → `2.12.0`).
2. Open a pull request. Its CI installs the new version through this action and
   proves it with `beplus --version`; the deploy path (`be auto` in Dockerfiles,
   base images, buildspecs) picks the same version up from the same file.
3. Merge it on its own — not together with an unrelated change — so a
   behaviour change it brings is attributable to the bump.

A repository without a pin keeps working — it installs `latest` — but every run
says so with a warning, because every CLI release changes its CI without a
commit there.

---

## Environment variables (optional)

Required only when `BE_NPM_AUTH` is set to `"true"`:

- `BE_NPM_TARGET` – npm target (registry / scope expected by `beplus npm auth`)
- `BE_NPM_TOKEN` – token used for npm authentication

`beplus npm auth` runs **only if**:
- `BE_NPM_AUTH == "true"`
- both `BE_NPM_TARGET` and `BE_NPM_TOKEN` are present

---

## Usage

### Minimal usage — the version the repository pins

```yaml
- uses: actions/checkout@v4

- uses: beplus/setup-beplus/cli@v2
```

---

### Install a specific version (overrides the pin)

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_CLI_VERSION: 2.11.0
```
---

### Enable `beplus npm auth`

Provide `BE_NPM_TARGET` and `BE_NPM_TOKEN` via GitHub secrets or variables.

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_NPM_AUTH: "true"
  env:
    BE_NPM_TARGET: ${{ vars.BE_NPM_TARGET }}
    BE_NPM_TOKEN: ${{ secrets.BE_NPM_TOKEN }}
```

---

## Example full workflow

```yaml
name: Test beplus

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v6
        with:
          node-version: 24

      # Installs the version pinned in beplus.estate.json → cli.version
      - uses: beplus/setup-beplus/cli@v2

      - run: |
          beplus --version
```

---

## Notes & troubleshooting

### Permission denied errors

This action avoids `sudo` by installing into `BE_PREFIX` (default: `$HOME/.beplus`).
If you override `BE_PREFIX`, ensure it points to a writable directory.

---

### "This repository does not pin the beplus CLI"

The run found no `cli.version` in the nearest `beplus.estate.json` (or no
manifest at all — is the repository checked out before this action?) and
installed `latest`. Add the pin; see [Pinning the CLI](#pinning-the-cli).

### "pins beplus CLI X, but `be auto` installed Y"

The pin is not an exact version, or `be` resolved it differently from the file
this action read. The run stops rather than continue on a CLI nobody chose.

---

### `BE_NPM_AUTH` appears to do nothing

This is expected unless:
- `BE_NPM_AUTH` is set to `"true"`
- `BE_NPM_TARGET` and `BE_NPM_TOKEN` are both set

---

## See also

- [Setup beplus CLI](../cli/README.md)
- [Setup beplus Provisioning](../provisioning/README.md)
