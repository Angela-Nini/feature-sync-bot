import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { DraftBlock, RelatedDoc } from "./types.js";

const execFileAsync = promisify(execFile);

type UpdateResult = {
  updated: RelatedDoc[];
  failed: Array<{ doc: RelatedDoc; reason: string }>;
};

// MVP implementation:
// - dry-run by default.
// - when DOC_UPDATE_MODE=cli, use local lark-cli to insert XML callout blocks.
//
// Recommended production behavior:
// - If existing Plan Availability / Region Availability blocks exist, replace them.
// - Otherwise insert after the document title, then fall back to the first heading or the end of the document.
// - Use Feishu highlight/callout blocks when wiring DocxXML update.
export async function updateRelatedDocs(docs: RelatedDoc[], blocks: DraftBlock[]): Promise<UpdateResult> {
  if (blocks.length === 0) {
    return { updated: [], failed: docs.map((doc) => ({ doc, reason: "No availability blocks generated." })) };
  }

  if (config.DOC_UPDATE_MODE === "dry-run") {
    return {
      updated: [],
      failed: docs.map((doc) => ({ doc, reason: "Dry run only. Set DOC_UPDATE_MODE=cli to edit Feishu docs." }))
    };
  }

  const updated: RelatedDoc[] = [];
  const failed: Array<{ doc: RelatedDoc; reason: string }> = [];

  for (const doc of docs) {
    try {
      await updateDocWithLarkCli(doc, blocks);
      updated.push(doc);
    } catch (error) {
      failed.push({
        doc,
        reason: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }

  return { updated, failed };
}

async function updateDocWithLarkCli(doc: RelatedDoc, blocks: DraftBlock[]): Promise<void> {
  const docRef = doc.url ?? doc.docId;
  if (!docRef) {
    throw new Error("Missing doc URL or doc ID.");
  }

  const anchorBlockId = await findAvailabilityInsertAnchorBlockId(docRef);
  const content = renderCalloutXml(blocks);
  const command = anchorBlockId ? "block_insert_after" : "append";
  const args = [
    "docs",
    "+update",
    "--api-version",
    "v2",
    "--doc",
    docRef,
    "--command",
    command,
    "--content",
    content,
    "--format",
    "json"
  ];

  if (anchorBlockId) {
    args.push("--block-id", anchorBlockId);
  }

  const { stdout, stderr } = await execFileAsync("lark-cli", args, { maxBuffer: 10 * 1024 * 1024 });
  if (stderr.trim()) {
    // lark-cli may print notices to stderr. Keep them visible but do not fail
    // unless stdout reports an error.
    console.warn(stderr.trim());
  }

  const result = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } };
  if (!result.ok) {
    throw new Error(result.error?.message ?? "lark-cli update failed");
  }
}

async function findAvailabilityInsertAnchorBlockId(docRef: string): Promise<string | null> {
  const args = [
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--doc",
    docRef,
    "--detail",
    "full",
    "--format",
    "json"
  ];

  const { stdout } = await execFileAsync("lark-cli", args, { maxBuffer: 20 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { ok?: boolean; data?: { document?: { content?: string } } };
  if (!result.ok) {
    return null;
  }

  const content = result.data?.document?.content ?? "";
  const titleMatch = content.match(/<title\b[^>]*\sid="([^"]+)"/);
  if (titleMatch?.[1]) {
    return titleMatch[1];
  }

  const headingMatch = content.match(/<h[1-6]\s+id="([^"]+)"/);
  return headingMatch?.[1] ?? null;
}

function renderCalloutXml(blocks: DraftBlock[]): string {
  return blocks.map((block) => (
    `<callout emoji="💡" background-color="light-blue" border-color="blue">` +
    `<p><a href="${escapeXmlAttribute(block.titleUrl)}">${escapeXmlText(block.title)}</a></p>` +
    `<p>${escapeXmlText(block.body)}</p>` +
    `</callout>`
  )).join("");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}
