import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, HTMLElement } from "node-html-parser";
import { config } from "./config.js";
import { parseCmsRegionNote } from "./regionWorkflow.js";
import { readRelatedDocsFromBase } from "./docsIndexReader.js";
import type { DraftBlock, RelatedDoc } from "./types.js";
const exec = promisify(execFile);
const directory = path.resolve("data/region-jobs");
export type Mutation = { action: "replace" | "insert" | "skip"; blockId: string; content: string; before: string };
type Snapshot = { doc: RelatedDoc; revision: number; xml: string; mutation: Mutation };
export type RegionJob = {
  id: string; code: string; chatId: string; userId: string; feature: string; identity: "bot" | "user";
  source: string; note: DraftBlock; snapshots: Snapshot[]; createdAt: number;
  status: "pending" | "executing" | "completed" | "failed" | "superseded";
};
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const normalized = (s: string) => s.replace(/\s+/g, " ").trim();

// Preserve a paragraph's inline style chain without copying links or unrelated elements.
function replacementParagraph(node: HTMLElement, text: string): string {
  const attrs = Object.entries(node.attributes).filter(([key]) => key !== "id").map(([k,v]) => ` ${k}="${escape(v)}"`).join("");
  let inner = escape(text);
  const wrappers: HTMLElement[] = [];
  let current = node;
  while (current.children.length) {
    if (current.children.length !== 1 || !/^(SPAN|B|EM|U)$/.test(current.children[0].tagName)
        || current.childNodes.some(child => !(child instanceof HTMLElement) && child.textContent.trim())) {
      throw new Error("Region note has mixed inline formatting; review manually");
    }
    current = current.children[0]; wrappers.push(current);
  }
  for (const wrapper of wrappers.reverse()) {
    const attributes = Object.entries(wrapper.attributes).filter(([k]) => k !== "id").map(([k,v]) => ` ${k}="${escape(v)}"`).join("");
    inner = `<${wrapper.tagName.toLowerCase()}${attributes}>${inner}</${wrapper.tagName.toLowerCase()}>`;
  }
  return `<p${attrs}>${inner}</p>`;
}

export function planRegionMutation(xml: string, note: DraftBlock): Mutation {
  const root = parse(xml);
  const nodes = root.children;
  const starts = root.querySelectorAll("p").filter(n => /<FeatureNote\b[^>]*variant=["']region["']/.test(n.textContent));
  if (starts.length > 1) throw new Error("Multiple region notes; review manually");
  if (starts.length === 1) {
    const opening = starts[0];
    const index = nodes.indexOf(opening);
    if (index < 0) throw new Error("Nested region note is not supported");
    if (!/^<FeatureNote\s+variant="region"\s+titleHref="\/docs\/cloud-providers-and-regions">$/.test(opening.textContent.trim())) {
      throw new Error("Unexpected region opening tag; review manually");
    }
    const body = nodes[index + 1];
    const closing = nodes[index + 2];
    if (body?.tagName !== "P" || body.textContent.includes("<FeatureNote") || closing?.textContent.trim() !== "</FeatureNote>") {
      throw new Error("Region note must contain one body paragraph between its tags");
    }
    const blockId = body.getAttribute("id");
    if (!blockId) throw new Error("Region body has no block ID");
    return { action: normalized(body.textContent) === normalized(note.body) ? "skip" : "replace",
      blockId, content: replacementParagraph(body, note.body), before: body.textContent };
  }
  // Refuse an unrecognized region marker instead of inserting a duplicate.
  if (root.textContent.includes('variant="region"') || root.textContent.includes("variant='region'")) throw new Error("Unrecognized existing region note");
  const planStarts = nodes.filter(n => /<FeatureNote\b[^>]*variant=["']plan["']/.test(n.textContent));
  if (planStarts.length > 1) throw new Error("Multiple plan notes; no safe insertion anchor");
  let anchor: HTMLElement | undefined;
  if (planStarts.length) {
    const index = nodes.indexOf(planStarts[0]);
    anchor = nodes.slice(index + 1).find(n => n.textContent.trim() === "</FeatureNote>");
    if (!anchor) throw new Error("Plan note is not closed");
  } else anchor = nodes.find(n => n.tagName === "TITLE") ?? nodes.find(n => n.tagName === "H1");
  const blockId = anchor?.getAttribute("id");
  if (!blockId) throw new Error("No safe insertion anchor at document beginning");
  const paragraph = (s: string) => `<p><span background-color="rgba(255,246,122,0.8)">${escape(s)}</span></p>`;
  return { action: "insert", blockId, before: "", content: paragraph(`<FeatureNote variant="region" titleHref="${note.titleHref}">`) + paragraph(note.body) + paragraph("</FeatureNote>") };
}

async function cli(args: string[]): Promise<any> {
  const { stdout } = await exec("lark-cli", args, { timeout: 60000, maxBuffer: 30 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (!result.ok || result.data?.result === "partial_success" || result.data?.result === "failed") throw new Error(result.error?.message || "Feishu operation was not successful");
  return result;
}
async function fetchDoc(doc: RelatedDoc, identity: string): Promise<{ xml: string; revision: number }> {
  const result = await cli(["docs", "+fetch", "--api-version", "v2", "--as", identity, "--doc", doc.url || doc.docId || "", "--detail", "full", "--format", "json"]);
  const document = result.data?.document;
  if (typeof document?.content !== "string" || !Number.isInteger(document.revision_id)) throw new Error("Missing full document content or revision");
  return { xml: document.content, revision: document.revision_id };
}
async function readSource(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`CMS returned HTTP ${response.status}`);
  return response.text();
}
export async function prepareRegionJob(feature: string, chatId: string, userId: string): Promise<{ job?: RegionJob; message: string }> {
  const note = parseCmsRegionNote(await readSource(config.CMS_FEATURES_URL), feature);
  const docs = await readRelatedDocsFromBase(feature);
  const snapshots: Snapshot[] = [];
  const errors: string[] = [];
  for (const doc of docs) {
    try {
      const { xml, revision } = await fetchDoc(doc, config.DOCS_INDEX_IDENTITY);
      snapshots.push({ doc, xml, revision, mutation: planRegionMutation(xml, note) });
    } catch (error) { errors.push(`${doc.title}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const id = crypto.randomUUID();
  const job: RegionJob = { id, code: crypto.randomBytes(3).toString("hex").toUpperCase(), chatId, userId, feature,
    identity: config.DOCS_INDEX_IDENTITY, source: config.CMS_FEATURES_URL, note, snapshots, createdAt: Date.now(), status: "pending" };
  const lines = [`${feature} region support 预览（尚未写入）`, `来源：${job.source}`, "",
    `<FeatureNote variant="region" titleHref="${note.titleHref}">`, note.body, "</FeatureNote>", "", `匹配 ${docs.length} 篇文档：`,
    ...snapshots.map(s => `- ${s.doc.title}: ${s.mutation.action}\n  ${s.doc.url}${s.mutation.before ? `\n  原文：${s.mutation.before}` : ""}`), ...errors.map(e => `- error: ${e}`)];
  if (!docs.length || errors.length || !snapshots.some(s => s.mutation.action !== "skip")) {
    lines.push(errors.length ? "有文档无法安全处理，本次不生成写入确认码。" : "没有需要写入的内容。");
    return { message: lines.join("\n") };
  }
  await store(job);
  lines.push("", `确认后仅更新 region note，保留 plan note。请由本次发起人在当前会话回复 ok ${job.code}（30 分钟内有效）。`);
  return { job, message: lines.join("\n") };
}

// Serialize confirmation and job state changes in this single-process local deployment.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation); queue = result.catch(() => {}); return result;
}
async function store(job: RegionJob): Promise<void> {
  await serial(async () => {
    await mkdir(directory, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(directory)) {
      if (!file.endsWith(".json")) continue;
      const old = JSON.parse(await readFile(path.join(directory, file), "utf8")) as RegionJob;
      if (old.chatId === job.chatId && old.userId === job.userId && old.status === "pending") {
        old.status = "superseded"; await save(old);
      }
    }
    await save(job);
  });
}
async function save(job: RegionJob): Promise<void> {
  const destination = path.join(directory, `${job.id}.json`);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, JSON.stringify(job, null, 2), { mode: 0o600 });
  await rename(temporary, destination);
}

export async function confirmRegionJob(code: string, chatId: string, userId: string): Promise<string | null> {
  return serial(async () => {
    const { readdir } = await import("node:fs/promises");
    let files: string[];
    try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let job: RegionJob | undefined;
    for (const file of files.filter(f => f.endsWith(".json"))) {
      const candidate = JSON.parse(await readFile(path.join(directory, file), "utf8")) as RegionJob;
      if (candidate.code === code && candidate.chatId === chatId && candidate.userId === userId) { job = candidate; break; }
    }
    if (!job) return null;
    if (job.status !== "pending") return `此确认任务已${job.status}，不会重复写入。请重新预览。`;
    if (Date.now() - job.createdAt > 30 * 60 * 1000) return "确认码已过期，请重新预览。";
    if (!config.REGION_WRITES_ENABLED) return "Region 写入未启用，未修改文档。";
    job.status = "executing"; await save(job);
    try {
      const currentNote = parseCmsRegionNote(await readSource(job.source), job.feature);
      if (JSON.stringify(currentNote) !== JSON.stringify(job.note)) throw new Error("CMS 信息在预览后发生变化，请重新预览");
      // Complete the preflight for every target before the first write.
      for (const snapshot of job.snapshots) {
        const current = await fetchDoc(snapshot.doc, job.identity);
        if (current.revision !== snapshot.revision || current.xml !== snapshot.xml) throw new Error(`${snapshot.doc.title} 在预览后发生变化，请重新预览`);
      }
      const results: string[] = [];
      let failed = false;
      for (const snapshot of job.snapshots) {
        if (snapshot.mutation.action === "skip") { results.push(`- ${snapshot.doc.title}: 内容一致，跳过`); continue; }
        try {
          // Check again immediately before mutation, with server-side revision as baseline.
          const current = await fetchDoc(snapshot.doc, job.identity);
          if (current.revision !== snapshot.revision || current.xml !== snapshot.xml) throw new Error("文档已变化，跳过");
          await cli(["docs", "+update", "--api-version", "v2", "--as", job.identity, "--doc", snapshot.doc.url || snapshot.doc.docId || "",
            "--command", snapshot.mutation.action === "replace" ? "block_replace" : "block_insert_after",
            "--block-id", snapshot.mutation.blockId, "--revision-id", String(snapshot.revision), "--content", snapshot.mutation.content, "--format", "json"]);
          const after = await fetchDoc(snapshot.doc, job.identity);
          if (planRegionMutation(after.xml, job.note).action !== "skip") throw new Error("已尝试写入，但回读校验失败；请检查文档后重新预览");
          if (outsideRegion(snapshot.xml) !== outsideRegion(after.xml)) throw new Error("已写入，但区域 note 以外内容的校验不一致，请人工检查");
          results.push(`- ${snapshot.doc.title}: 已更新并回读校验\n  ${snapshot.doc.url}`);
        } catch (error) {
          failed = true; results.push(`- ${snapshot.doc.title}: ${error instanceof Error ? error.message : String(error)}`);
          results.push("后续文档停止写入；请检查后重新预览。"); break;
        }
      }
      job.status = failed ? "failed" : "completed"; await save(job);
      return [`${job.feature} region note 处理结果：`, ...results].join("\n");
    } catch (error) {
      job.status = "failed"; await save(job);
      return `确认任务停止：${error instanceof Error ? error.message : String(error)}。请重新预览后确认。`;
    }
  });
}

export function outsideRegion(xml: string): string {
  const root = parse(xml); const nodes = root.children;
  const start = nodes.findIndex(n => /<FeatureNote\b[^>]*variant=["']region["']/.test(n.textContent));
  if (start >= 0) {
    const end = nodes.findIndex((n,i) => i >= start && n.textContent.includes("</FeatureNote>"));
    if (end < start) throw new Error("Unclosed region note");
    nodes.slice(start, end + 1).forEach(n => n.remove());
  }
  return root.toString().replace(/\s+id="[^"]*"/g, "").replace(/>\s+</g, "><").trim();
}
