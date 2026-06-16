# Feature Sync Bot

Feature Sync Bot listens for Feishu group messages, reads the Zilliz Cloud feature matrix source of truth, generates availability callouts, waits for confirmation, and updates related docs.

## MVP Flow

```text
@Angela 已更新 Global Cluster 功能支持情况
  -> bot reads the source of truth
  -> bot generates Plan Availability / Region Availability draft
  -> bot sends the draft back to the group
  -> user replies ok
  -> bot updates related docs
```

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Expose the local server with a public HTTPS URL, then configure Feishu event subscription:

```text
POST https://your-domain.com/feishu/events
```

Subscribe to:

```text
im.message.receive_v1
```

## Required Feishu Scopes

```text
im:message
im:message:readonly
docx:document:read
docx:document:write
wiki:wiki:read
```

## Current State

Implemented:

- Feishu event URL verification
- Tenant access token retrieval
- Group message handling
- Feature-name parsing
- Draft generation from a source-of-truth reader interface
- Pending confirmation store
- Message replies
- Source-of-truth table parsing
- Optional `lark-cli` based Feishu doc updates with `DOC_UPDATE_MODE=cli`

TODO:

- Confirm `larkDocClient.ts` raw-content API against your Feishu tenant.
- Replace `docUpdater.ts` CLI mode with direct Feishu Docx OpenAPI calls if this service will run without `lark-cli`.
- Add encrypted event support if Feishu event encryption is enabled.

## Preview Generated Content

```bash
npm run preview -- "Global Cluster"
```

## Enable Doc Updates

By default the bot does not edit Feishu docs:

```bash
DOC_UPDATE_MODE=dry-run
```

For local MVP testing on a machine where `lark-cli` is authenticated:

```bash
DOC_UPDATE_MODE=cli
```

In CLI mode, the bot runs `lark-cli docs +fetch` and `lark-cli docs +update` to insert availability callouts after the first heading in each related document.

## Real Feishu Group Test

See [docs/deploy-feishu.md](docs/deploy-feishu.md).
