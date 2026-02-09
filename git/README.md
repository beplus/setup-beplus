# Setup beplus Git (GitHub Action)

Composite GitHub Action that configures Git for the GitHub Actions runner using a **GitHub App** for authentication. This enables secure git operations (push, tag, commit) without exposing personal access tokens.

---

## What it does

1. Generates a token from the GitHub App (`beplus-release-bot`)
2. Configures git user name and email
3. Sets up git credentials helper with the generated token
4. Enables secure git operations (push, tag, commit) in subsequent steps

---

## Inputs

| Input | Required | Default | Description |
|------|----------|---------|-------------|
| `BE_RELEASE_GITHUB_APP_ID` | Yes | - | The App ID of your GitHub App |
| `BE_RELEASE_GITHUB_APP_PRIVATE_KEY` | Yes | - | The private key of your GitHub App |
| `BE_RELEASE_GITHUB_APP_NAME` | No | `beplus-release-bot` | Name of the GitHub App (used for git user.name and user.email) |

---

## Usage

### Minimal usage

```yaml
- uses: beplus/setup-beplus/git@v1
  with:
    BE_RELEASE_GITHUB_APP_ID: ${{ secrets.BE_RELEASE_GITHUB_APP_ID }}
    BE_RELEASE_GITHUB_APP_PRIVATE_KEY: ${{ secrets.BE_RELEASE_GITHUB_APP_PRIVATE_KEY }}
```

---

### Custom GitHub App name

If your app has a different name, override it:

```yaml
- uses: beplus/setup-beplus/git@v1
  with:
    BE_RELEASE_GITHUB_APP_ID: ${{ secrets.BE_RELEASE_GITHUB_APP_ID }}
    BE_RELEASE_GITHUB_APP_PRIVATE_KEY: ${{ secrets.BE_RELEASE_GITHUB_APP_PRIVATE_KEY }}
    BE_RELEASE_GITHUB_APP_NAME: my-custom-bot
```

---

## Prerequisites

### 1. Create a GitHub App

1. Go to your GitHub org settings → **Developer settings** → **GitHub Apps**
2. Click **New GitHub App**
3. Configure:
   - **App name**: `beplus-release-bot` (or your custom name)
   - **Homepage URL**: `https://github.com/beplus`
   - **Webhook**: Uncheck "Active" (not needed for this use case)
4. Under **Repository permissions**, grant:
   - `Contents: Read & Write` (for commits, tags, pushes)
   - `Pull requests: Read & Write` (optional, for PR comments)
5. Click **Create GitHub App**

### 2. Install the App in your repository

1. Go to your org/repo settings → **Integrations** → **GitHub Apps**
2. Click **Install** next to your app
3. Select the repositories where it should have access

### 3. Add secrets to your repository

1. In your repo settings → **Secrets and variables** → **Actions**:
   - Add **Variable**: `BE_RELEASE_GITHUB_APP_ID` (copy from app page)
   - Add **Secret**: `BE_RELEASE_GITHUB_APP_PRIVATE_KEY` (generate and copy from app page)

Alternatively, set these at the **organization level** for use across multiple repos.
