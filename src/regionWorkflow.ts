import { parse } from "node-html-parser";
import { config } from "./config.js";
import { readRelatedDocsFromBase } from "./docsIndexReader.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DraftBlock, RelatedDoc } from "./types.js";
const exec = promisify(execFile);

export function parseRegionCommand(text: string): string | null {
  const clean = text.replace(/<at\b[^>]*>.*?<\/at>/g, "").replace(/@_user_\d+/g, "").trim();
  const match = clean.match(/^(?:预览|更新|同步|preview|update|sync)\s*(.+?)\s+(?:region\s+(?:support|availability)|区域支持(?:情况)?)\s*$/i);
  return match?.[1]?.trim() || null;
}

function plain(value: string): string {
  return parse(value.replace(/<br\s*\/?\s*>/gi, "\n")).textContent
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`/g, "").trim();
}

export function regionClause(raw: string, cloud: string): string {
  const value = plain(raw).replace(/✅|ℹ️/g, "").trim();
  if (/^(?:Not available|Not supported|❌)\.?$/i.test(value)) return `It is not available on ${cloud}.`;
  const request = /\b(?:on request|available on request)\b/i.test(value);
  if (/^(?:Available on request in )?all (?:listed )?regions\.?$/i.test(value)) {
    return `This feature is available${request ? " on request" : ""} in all listed ${cloud} regions.`;
  }
  const prefix = value.match(/^(?:Available on request in|Selected regions|Part of the regions|The following regions)\s*:\s*/i);
  if (!prefix) throw new Error(`Unrecognized ${cloud} availability; update stopped: ${value || "(empty)"}`);
  const regions = value.slice(prefix[0].length).split(/[\n,;]+/).map(x => x.trim().replace(/^[-*]\s*/, ""));
  if (!regions.length || regions.some(x => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(x))) {
    throw new Error(`Invalid or incomplete ${cloud} region list.`);
  }
  const unique = [...new Set(regions)];
  const list = unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
  return `This feature is available${request ? " on request" : ""} in the following ${cloud} regions: ${list}.`;
}

export function parseCmsRegionNote(markdown: string, feature: string): DraftBlock {
  const normalize = (s: string) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const rows = markdown.split(/\r?\n/).filter(x => x.trim().startsWith("|"))
    .map(x => x.trim().slice(1, -1).split("|").map(c => c.trim()));
  const header = rows.findIndex(r => normalize(r[0] || "") === "feature" && r.some(c => c === "AWS"));
  if (header < 0) throw new Error("CMS response has no feature region table.");
  const headers = rows[header].map(normalize);
  const matches = rows.slice(header + 1).filter(r => normalize(r[0] || "") === normalize(feature));
  if (matches.length !== 1) throw new Error(`Expected one CMS feature matching ${feature}; found ${matches.length}.`);
  const row = matches[0];
  const body = [["aws", "AWS"], ["google cloud", "Google Cloud"], ["microsoft azure", "Microsoft Azure"]]
    .map(([key, label]) => {
      const index = headers.indexOf(key);
      if (index < 0 || !row[index]) throw new Error(`CMS is missing ${label} availability.`);
      return regionClause(row[index], label);
    });
  let availableCount = 0;
  const text = body.map(sentence => {
    if (sentence.startsWith("It is not available")) return sentence.replace(/^It is/, "This feature is");
    let phrase = sentence.replace(/^This feature is available /, "").replace(/\.$/, "");
    const onRequest = phrase.startsWith("on request ");
    if (onRequest) phrase = phrase.slice("on request ".length);
    phrase = phrase.replace(/all listed /, "all supported ");
    phrase = phrase.replace(/in the following (AWS|Google Cloud|Microsoft Azure) regions: (.+)$/, (_match, cloud: string, list: string) =>
      `in ${cloud} regions ${list.replace(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, region => `\`${region}\``)}`);
    const subject = availableCount++ === 0 ? "This feature is available" : "It is also available";
    return `${subject} ${phrase}${onRequest ? " on request" : ""}.`;
  }).join(" ");
  return { variant: "region", titleHref: config.REGION_TITLE_HREF, body: text };
}

export type NotePreview = { action: "replace" | "insert" | "skip" | "error"; before?: string; reason?: string };
export function inspectRegionNote(xml: string, body: string): NotePreview {
  const nodes = parse(xml).querySelectorAll("p, title, h1, h2");
  const starts = nodes.filter(n => /<FeatureNote\b[^>]*variant=["']region["']/.test(n.textContent));
  if (starts.length > 1) return { action: "error", reason: "Multiple region notes" };
  if (!starts.length) return { action: "insert" };
  const start = nodes.indexOf(starts[0]);
  let text = "";
  for (let i = start; i < nodes.length; i++) {
    text += `${nodes[i].textContent}\n`;
    if (/<\/FeatureNote>/.test(nodes[i].textContent)) {
      const match = text.match(/<FeatureNote\b[^>]*>([\s\S]*?)<\/FeatureNote>/);
      if (!match) return { action: "error", reason: "Malformed region note" };
      const before = match[1].trim();
      return { action: before.replace(/\s+/g, " ") === body.replace(/\s+/g, " ") ? "skip" : "replace", before };
    }
    if (i > start && /<FeatureNote\b/.test(nodes[i].textContent)) break;
  }
  return { action: "error", reason: "Missing region note closing tag" };
}

export async function previewRegionSupport(feature: string): Promise<string> {
  const response = await fetch(config.CMS_FEATURES_URL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`CMS returned HTTP ${response.status}`);
  const note = parseCmsRegionNote(await response.text(), feature);
  const docs = await readRelatedDocsFromBase(feature);
  const results: string[] = [];
  for (const doc of docs) {
    try {
      const xml = await fetchPreviewDoc(doc);
      const result = inspectRegionNote(xml, note.body);
      results.push(`- ${doc.title}: ${result.action}${result.reason ? ` (${result.reason})` : ""}\n  ${doc.url}${result.before ? `\n  原文：${result.before}` : ""}`);
    } catch (error) {
      results.push(`- ${doc.title}: error (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return [`${feature} region support 预览（未写入，不生成确认任务）`, `来源：${config.CMS_FEATURES_URL}`, "",
    `<FeatureNote variant="region" titleHref="${note.titleHref}">`, note.body, "</FeatureNote>", "",
    `匹配 ${docs.length} 篇文档：`, ...results, ...(docs.length ? [] : ["没有找到目标文档，请检查索引。"])].join("\n");
}
async function fetchPreviewDoc(doc: RelatedDoc): Promise<string> {
  const { stdout } = await exec("lark-cli", ["docs", "+fetch", "--api-version", "v2", "--as", config.DOCS_INDEX_IDENTITY,
    "--doc", doc.url || doc.docId || "", "--detail", "full", "--format", "json"], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (!result.ok || typeof result.data?.document?.content !== "string") throw new Error(result.error?.message || "Document read failed");
  return result.data.document.content;
}
