# Setup beplus CLI (GitHub Action)

Composite GitHub Action that installs [@beplus/be](https://github.com/beplus/be) and then installs the [**beplus CLI**](https://github.com/beplus/cli) (`beplus`) into a **writable prefix** (no `sudo` required). Optionally runs `beplus npm auth` for [beplus.cloud](https://beplus.cloud) package access.

---

## What it does

1. Installs `be` using the official install script
2. Installs `beplus` via `be <version>`
3. Verifies `beplus --version`
4. Optionally runs `beplus npm auth` if enabled and required environment variables are present

---

## Inputs

| Input | Required | Default | Description |
|------|----------|---------|-------------|
| `BE_CLI_VERSION` | No | `latest` | Version or channel of beplus CLI to install (passed to `be`) |
| `BE_NPM_AUTH` | No | `false` | If `true`, runs `beplus npm auth` |
| `BE_PREFIX` | No | empty | Install prefix for beplus binaries. If empty, defaults to `$HOME/.beplus`. Must be writable. |

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

### Minimal usage

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_CLI_VERSION: latest
```

---

### Install a specific version

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_CLI_VERSION: v1.0.0-beta.3
```
---

### Enable `beplus npm auth`

Provide `BE_NPM_TARGET` and `BE_NPM_TOKEN` via GitHub secrets or variables.

```yaml
- uses: beplus/setup-beplus/cli@v2
  with:
    BE_CLI_VERSION: latest
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

      - uses: beplus/setup-beplus/cli@v2
        with:
          BE_CLI_VERSION: latest

      - run: |
          beplus --version
```

---

## Notes & troubleshooting

### Permission denied errors

This action avoids `sudo` by installing into `BE_PREFIX` (default: `$HOME/.beplus`).
If you override `BE_PREFIX`, ensure it points to a writable directory.

---

### `BE_NPM_AUTH` appears to do nothing

This is expected unless:
- `BE_NPM_AUTH` is set to `"true"`
- `BE_NPM_TARGET` and `BE_NPM_TOKEN` are both set

---

## See also

- [Setup beplus CLI](../cli/README.md)
- [Setup beplus Provisioning](../provisioning/README.md)
