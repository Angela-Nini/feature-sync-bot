# Feature Sync Bot

Feature Sync Bot is a Feishu bot for syncing Zilliz Cloud feature availability notes from a source-of-truth matrix into related documentation pages.

The bot listens to group messages, reads the Zilliz Cloud feature matrix, generates Plan Availability and Region Availability callouts, asks for an explicit confirmation code, and then inserts the callouts into the related Feishu docs.

## Workflow

```text
@Angela 已更新 Global Cluster 功能支持情况
  -> bot reads the Source of Truth matrix
  -> bot finds the feature's plan and region availability
  -> bot generates availability callout drafts
  -> bot replies with target docs and a one-time confirmation code
  -> user replies ok <confirmation-code>
  -> bot inserts the callouts into related docs
```

Example confirmation:

```text
回复 ok ABC123 后我会自动插入。
```

Only the full confirmation message writes to docs:

```text
ok ABC123
```

A plain `ok` does not write anything.

## Supported Trigger Format

The bot currently recognizes messages like:

```text
@Angela 已更新 Global Cluster 功能支持情况
@Angela 同步 CMEK 功能支持情况
@Angela sync Cross-region backup availability
```

The feature name must exist in the Source of Truth matrix. Related docs must be listed in the matrix if you want the bot to write the generated callouts.

## Callout Behavior

The bot generates:

- `Plan Availability` when the feature is not available on all listed plans.
- `Region Availability` when the feature is not available in all listed cloud regions.

Each callout title is rendered as normal paragraph text with a link, not as a heading. In CLI write mode, callouts are inserted directly below the Feishu document title. If the title block cannot be found, the bot falls back to the first heading, then to appending at the end.

## Setup

```bash
cp .env.example .env
npm install
npm run build
node dist/index.js
```

For local Feishu testing, expose port `3000` with a public HTTPS tunnel:

```bash
ngrok http 3000
```

Configure the Feishu event callback URL as:

```text
https://<your-domain>/feishu/events
```

The current service also returns JSON for `GET /feishu/events`, which helps Feishu console validation avoid HTML 404 responses.

## Environment Variables

```env
PORT=3000
HOST=127.0.0.1

LARK_APP_ID=cli_aaa8c4b52f79dbcb
LARK_APP_SECRET=replace_with_your_app_secret
LARK_VERIFICATION_TOKEN=replace_with_event_subscription_verification_token
LARK_ENCRYPT_KEY=

SOURCE_OF_TRUTH_DOC=https://zilliverse.feishu.cn/wiki/TT8owSPZhiot7IkeNYrcrvobnPe?from=from_copylink
SOURCE_OF_TRUTH_FIXTURE_PATH=

PLAN_DOC_URL=https://docs.zilliz.com/docs/select-zilliz-cloud-service-plans
REGION_DOC_URL=https://docs.zilliz.com/docs/cloud-providers-and-regions

DOC_UPDATE_MODE=dry-run
```

Never commit `.env`. The repository ignores `.env`, `node_modules`, `dist`, and runtime pending jobs.

## Required Feishu Configuration

Enable the bot capability for the Feishu app and subscribe to:

```text
im.message.receive_v1
```

Required scopes:

```text
im:message
im:message:readonly
im:message.p2p_msg:readonly
docx:document:read
docx:document:write
wiki:wiki:read
```

Keep event encryption disabled unless encrypted-event handling is implemented.

## Preview Generated Content

```bash
npm run preview -- "Global Cluster"
```

## Doc Update Modes

Use dry run while testing the group-message flow:

```env
DOC_UPDATE_MODE=dry-run
```

Use CLI mode for real writes:

```env
DOC_UPDATE_MODE=cli
```

CLI mode requires `lark-cli` to work in the runtime environment:

```bash
lark-cli docs +fetch --api-version v2 --as bot --doc "<target-doc-url>"
lark-cli docs +update --api-version v2 --as bot --doc "<target-doc-url>" --command append --content "<p>test</p>"
```

On macOS automation environments, `lark-cli` may fail with `keychain not initialized`. Run this once if needed:

```bash
lark-cli config keychain-downgrade
```

## Development Commands

```bash
npm run typecheck
npm run build
npm run preview -- "Global Cluster"
```

## Deployment Notes

See [docs/deploy-feishu.md](docs/deploy-feishu.md) for the step-by-step Feishu group test flow.

