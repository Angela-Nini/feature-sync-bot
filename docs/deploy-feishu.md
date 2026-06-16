# Deploy and Test With a Feishu Group

This guide connects Feature Sync Bot to a real Feishu group.

## 1. Configure Feishu App Permissions

In the Feishu developer console for app `cli_aaa8c4b52f79dbcb`, enable these scopes:

```text
im:message
im:message:readonly
im:message.p2p_msg:readonly
docx:document:read
docx:document:write
wiki:wiki:read
```

If the developer console prompts for a group-message read scope when subscribing to `im.message.receive_v1`, enable that scope too.

For the first test, keep event encryption disabled. The bot currently rejects encrypted events.

## 2. Add the Bot to the Test Group

Add the app bot to the Feishu group where you want to test:

```text
@Angela 已更新 Global Cluster 功能支持情况
```

## 3. Share Docs With the Bot

Make sure the bot can access:

- Source of truth: `https://zilliverse.feishu.cn/wiki/TT8owSPZhiot7IkeNYrcrvobnPe`
- Related docs listed in the source-of-truth table

For MVP testing, add the bot as a collaborator with edit permission.

## 4. Set Environment Variables

```bash
PORT=3000
HOST=0.0.0.0
LARK_APP_ID=cli_aaa8c4b52f79dbcb
LARK_APP_SECRET=<your-app-secret>
LARK_VERIFICATION_TOKEN=<event-subscription-verification-token>
SOURCE_OF_TRUTH_DOC=https://zilliverse.feishu.cn/wiki/TT8owSPZhiot7IkeNYrcrvobnPe?from=from_copylink
PLAN_DOC_URL=https://docs.zilliz.com/docs/select-zilliz-cloud-service-plans
REGION_DOC_URL=https://docs.zilliz.com/docs/cloud-providers-and-regions
DOC_UPDATE_MODE=dry-run
```

Use `DOC_UPDATE_MODE=dry-run` for the first real group test. Switch to `DOC_UPDATE_MODE=cli` only after the message flow is verified on a machine that has `lark-cli` authenticated and can access the target docs.

## 5. Run Locally

```bash
npm install
npm run build
node dist/index.js
```

Expose it with a public HTTPS tunnel such as ngrok or Cloudflare Tunnel:

```bash
ngrok http 3000
```

Use the generated HTTPS URL as the Feishu event callback:

```text
https://<your-domain>/feishu/events
```

## 6. Configure Event Subscription

In Feishu developer console:

```text
Events and Callbacks -> Event Subscription
Request URL: https://<your-domain>/feishu/events
```

Subscribe to:

```text
im.message.receive_v1
```

When Feishu verifies the URL, the bot responds to `url_verification` automatically.

## 7. Test in Group

Send:

```text
@Angela 已更新 Global Cluster 功能支持情况
```

Expected bot reply:

```text
已根据 Source of truth 生成 Global cluster 的 availability 内容：

[Plan Availability]
This feature is available only on Business Critical (SaaS) and BYOC deployments.

[Region Availability]
This feature is available in all AWS regions and in the following Google Cloud regions: gcp-us-central1 and gcp-us-east4. It is not available on Microsoft Azure.

将更新以下文档：
- Global Cluster Explained

回复 ok ABC123 后我会自动插入。
```

Then reply with the exact confirmation code shown by the bot:

```text
ok ABC123
```

The confirmation code changes for each draft. A plain `ok` does not write anything.

With `DOC_UPDATE_MODE=dry-run`, the bot should report that no docs were updated because dry-run mode is enabled.

## 8. Enable Real Writes

After the group flow works, set:

```bash
DOC_UPDATE_MODE=cli
```

Then confirm that the runtime environment has:

```bash
lark-cli docs +fetch --api-version v2 --as bot --doc "<target-doc-url>"
```

working with write access.

If `lark-cli` fails with `keychain not initialized` in a macOS automation environment, run:

```bash
lark-cli config keychain-downgrade
```

In CLI mode, callouts are inserted below the document title. If the title block cannot be found, the bot falls back to the first heading and then to appending at the end.

## 9. Deploy With Docker

```bash
docker build -t feature-sync-bot .
docker run --env-file .env -p 3000:3000 feature-sync-bot
```

For hosted deployment, use Cloud Run, Render, Fly.io, ECS, or any internal HTTPS service.
