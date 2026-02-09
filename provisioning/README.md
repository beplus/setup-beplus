# Setup beplus Provisioning (GitHub Action)

Composite GitHub Action that configures AWS credentials via OIDC and installs beplus Provisioning tools with optional plugins.

---

## What it does

1. Configures AWS credentials using OIDC (OpenID Connect) for secure, keyless authentication
2. Constructs the IAM role ARN dynamically based on org, repo, and branch
3. Verifies AWS identity
4. Installs `@beplus/provisioning` globally
5. Conditionally installs provisioning plugins based on inputs (e.g., `@beplus/provisioning-plugin-mobile`)

---

## Inputs

| Input | Required | Default | Description |
|------|----------|---------|-------------|
| `AWS_REGION` | No | `us-east-1` | AWS region to use |
| `BE_AWS_ACCOUNT_ID` | Yes | - | AWS Account ID where to install beplus Provisioning |
| `BE_PROVISIONING_PLUGIN_MOBILE_ENABLED` | No | `false` | Whether to install the Mobile plugin |

---

## IAM Role Naming Convention

The action automatically constructs the IAM role ARN using the pattern:

```
arn:aws:iam::{BE_AWS_ACCOUNT_ID}:role/github-actions-{org}-{repo}-{branch}-provisioning
```

**Example:**
- Org: `bepluscloud`
- Repo: `monorepo`
- Branch: `main`
- Account: `123456789012`

**Result:** `arn:aws:iam::123456789012:role/github-actions-bepluscloud-monorepo-main-provisioning`

---

## Usage

### Minimal usage

```yaml
- uses: beplus/setup-beplus/provisioning@v2
  with:
    BE_AWS_ACCOUNT_ID: ${{ vars.BE_AWS_ACCOUNT_ID }}
```

---

### With mobile plugin enabled

```yaml
- uses: beplus/setup-beplus/provisioning@v2
  with:
    BE_AWS_ACCOUNT_ID: ${{ vars.BE_AWS_ACCOUNT_ID }}
    BE_PROVISIONING_PLUGIN_MOBILE_ENABLED: true
```

---

### Custom AWS region

```yaml
- uses: beplus/setup-beplus/provisioning@v1
  with:
    AWS_REGION: eu-central-1
    BE_AWS_ACCOUNT_ID: ${{ vars.BE_AWS_ACCOUNT_ID }}
```

---

### Full workflow example

```yaml
name: beplus Provisioning

on:
  workflow_dispatch:

permissions:
  id-token: write  # Required for OIDC
  contents: read

jobs:
  update-provisioning:
    runs-on: ubuntu-latest
    environment: ${{ github.ref_name }}

    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 22.14

      - uses: beplus/setup-beplus/cli@v2
        env:
          BE_NPM_TARGET: ${{ vars.BE_NPM_TARGET }}
          BE_NPM_TOKEN: ${{ secrets.BE_NPM_TOKEN }}
        with:
          BE_CLI_VERSION: latest
          BE_NPM_AUTH: true

      - uses: beplus/setup-beplus/provisioning@v2
        with:
          BE_AWS_ACCOUNT_ID: ${{ vars.BE_AWS_ACCOUNT_ID }}
          BE_PROVISIONING_PLUGIN_MOBILE_ENABLED: ${{ vars.BE_PROVISIONING_PLUGIN_MOBILE_ENABLED }}

      - name: Run provisioning
        run: beplus-provision
```

---

## Prerequisites

### 1. Configure AWS OIDC for GitHub Actions

Your AWS account must have an OIDC identity provider configured for GitHub Actions. See [AWS documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html).

### 2. Create IAM Role

Create an IAM role with the following:

**Trust Policy:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::{ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:{ORG}/{REPO}:*"
        }
      }
    }
  ]
}
```

**Role name:** `github-actions-{org}-{repo}-{branch}-provisioning`

**Permissions:** `@todo`

### 3. Set repository variables

In your repository settings → **Settings** → **Secrets and variables** → **Actions**:
- Add **Variable**: `BE_AWS_ACCOUNT_ID` (your AWS account ID)
- Add **Variable** (optional): `BE_PROVISIONING_PLUGIN_MOBILE_ENABLED` (set to `true` or `1` if needed)

Alternatively, set these at the **organization** or **environment** level for use across multiple repos.

### 4. Enable OIDC permissions in workflow

Your workflow must include the `id-token: write` permission:

```yaml
permissions:
  id-token: write
  contents: read
```

---

## See also

- [Setup beplus CLI](../cli/README.md)
- [Setup beplus Git](../git/README.md)
