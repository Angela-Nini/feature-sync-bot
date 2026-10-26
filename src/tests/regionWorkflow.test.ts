import test from "node:test";
import assert from "node:assert/strict";
import { parseCmsRegionNote, parseRegionCommand, inspectRegionNote } from "../regionWorkflow.js";
import { isFeatureSection } from "../docsIndexReader.js";
const cms = `| Feature | AWS | Google Cloud | Microsoft Azure |
| --- | --- | --- | --- |
| [Global cluster](https://example.com) | ✅ All listed regions | Available on [request](https://support.zilliz.com/) in:<br><br>- \`us-central1\`<br>- \`us-east4\` | Not available |`;
test("CMS retains request requirement and region identifiers without inventing a prefix", () => {
  const note = parseCmsRegionNote(cms, "Global Cluster");
  assert.equal(note.variant, "region");
  assert.equal(note.body, "This feature is available in all supported AWS regions. It is also available in Google Cloud regions `us-central1` and `us-east4` on request. This feature is not available on Microsoft Azure.");
});
test("missing, duplicate, or unknown CMS data stops preview", () => {
  assert.throws(() => parseCmsRegionNote(cms.replace("✅ All listed regions", ""), "Global cluster"));
  assert.throws(() => parseCmsRegionNote(cms + "\n" + cms.split("\n")[2], "Global cluster"));
  assert.throws(() => parseCmsRegionNote(cms.replace("Not available", "coming soon"), "Global cluster"));
  assert.throws(() => parseCmsRegionNote(cms, "Global"));
});
test("region commands preserve feature name and accept Feishu mentions", () => {
  assert.equal(parseRegionCommand('<at user_id="a">Bot</at> 预览 Global Cluster region support'), "Global Cluster");
  assert.equal(parseRegionCommand("更新 Global Cluster 区域支持情况"), "Global Cluster");
  assert.equal(parseRegionCommand("hello"), null);
});
const p = (value: string) => `<p><span background-color="yellow">${value.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</span></p>`;
const noteXml = p('<FeatureNote variant="region" titleHref="/docs/cloud-providers-and-regions">') + p("Old text.") + p("</FeatureNote>");
test("note preview spans styled paragraphs and ignores plan note", () => {
  const plan = p('<FeatureNote variant="plan">') + p("Plan text.") + p("</FeatureNote>");
  assert.deepEqual(inspectRegionNote(plan + noteXml, "New text."), { action: "replace", before: "Old text." });
  assert.equal(inspectRegionNote(noteXml, "Old text.").action, "skip");
  assert.equal(inspectRegionNote(plan, "New text.").action, "insert");
});
test("ambiguous or unclosed notes are errors", () => {
  assert.equal(inspectRegionNote(noteXml + noteXml, "New").action, "error");
  assert.equal(inspectRegionNote(p('<FeatureNote variant="region">'), "New").action, "error");
});
test("only exact feature sections are hierarchy roots", () => {
  assert.equal(isFeatureSection({ title: "Global Cluster", slug: "global-cluster", placement: ["section"] }, "Global Cluster"), true);
  assert.equal(isFeatureSection({ title: "Other", slug: "other", placement: ["section"] }, "Global Cluster"), false);
});

const { planRegionMutation, outsideRegion } = await import("../regionConfirmation.js");
const draft = { variant: "region" as const, titleHref: "/docs/cloud-providers-and-regions", body: "New text & details." };
const fullXml = `<title id="title">Demo</title><p id="plan-start">&lt;FeatureNote variant="plan"&gt;</p><p id="plan-body"><span background-color="green">Plan unchanged.</span></p><p id="plan-end">&lt;/FeatureNote&gt;</p><p id="region-start"><span background-color="yellow">&lt;FeatureNote variant="region" titleHref="/docs/cloud-providers-and-regions"&gt;</span></p><p id="region-body"><span background-color="yellow">Old text.</span></p><p id="region-end">&lt;/FeatureNote&gt;</p><p id="intro">Introduction unchanged.</p>`;
test("write plan targets only region body, retaining highlight and escaping text", () => {
  const mutation = planRegionMutation(fullXml, draft);
  assert.equal(mutation.action, "replace");
  assert.equal(mutation.blockId, "region-body");
  assert.equal(mutation.content, '<p><span background-color="yellow">New text &amp; details.</span></p>');
  const after = fullXml.replace('<p id="region-body"><span background-color="yellow">Old text.</span></p>', mutation.content.replace('<p>', '<p id="new-body">'));
  assert.equal(planRegionMutation(after, draft).action, "skip");
  assert.equal(outsideRegion(fullXml), outsideRegion(after));
});
test("missing region note inserts after plan closing tag, preserving plan", () => {
  const without = fullXml.replace(/<p id="region-start">[\s\S]*?<p id="region-end">[\s\S]*?<\/p>/, "");
  const mutation = planRegionMutation(without, draft);
  assert.equal(mutation.action, "insert");
  assert.equal(mutation.blockId, "plan-end");
  assert.match(mutation.content, /&lt;FeatureNote variant=&quot;region&quot;/);
  assert.match(mutation.content, /background-color="rgba\(255,246,122,0.8\)"/);
});
test("write plan refuses duplicate, multi-paragraph, mixed formatting, and malformed notes", () => {
  assert.throws(() => planRegionMutation(fullXml + fullXml, draft));
  assert.throws(() => planRegionMutation(fullXml.replace('<p id="region-end">', '<p id="extra">Another paragraph.</p><p id="region-end">'), draft));
  assert.throws(() => planRegionMutation(fullXml.replace("Old text.", "Old <b>text.</b>"), draft));
  assert.throws(() => planRegionMutation(fullXml.replace('titleHref="/docs/cloud-providers-and-regions"', 'titleHref="/unexpected"'), draft));
});
test("outside-note verification detects changes in plan and surrounding text", () => {
  assert.notEqual(outsideRegion(fullXml), outsideRegion(fullXml.replace("Plan unchanged", "Plan changed")));
  assert.notEqual(outsideRegion(fullXml), outsideRegion(fullXml.replace("Introduction unchanged", "Changed")));
});

test("confirmation is scoped, expires, and cannot replay; disabled writes do not mutate", async () => {
  const { mkdir, writeFile, unlink } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { confirmRegionJob } = await import("../regionConfirmation.js");
  const { config } = await import("../config.js");
  const id = randomUUID();
  const file = `data/region-jobs/${id}.json`;
  const fixture = { id, code: "TEST99", chatId: "test-chat", userId: "test-user", feature: "Test", identity: "user", source: "https://invalid.example", note: draft, snapshots: [], createdAt: Date.now(), status: "pending" };
  const previous = config.REGION_WRITES_ENABLED;
  config.REGION_WRITES_ENABLED = false;
  await mkdir("data/region-jobs", { recursive: true });
  try {
    await writeFile(file, JSON.stringify(fixture));
    assert.equal(await confirmRegionJob("TEST99", "wrong-chat", "test-user"), null);
    assert.equal(await confirmRegionJob("TEST99", "test-chat", "wrong-user"), null);
    assert.match((await confirmRegionJob("TEST99", "test-chat", "test-user"))!, /未启用/);
    await writeFile(file, JSON.stringify({ ...fixture, createdAt: Date.now() - 31 * 60 * 1000 }));
    assert.match((await confirmRegionJob("TEST99", "test-chat", "test-user"))!, /过期/);
    await writeFile(file, JSON.stringify({ ...fixture, status: "completed" }));
    assert.match((await confirmRegionJob("TEST99", "test-chat", "test-user"))!, /不会重复写入/);
  } finally {
    config.REGION_WRITES_ENABLED = previous;
    await unlink(file);
  }
});
