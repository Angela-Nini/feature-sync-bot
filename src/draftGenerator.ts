import { config } from "./config.js";
import type { DraftBlock, FeatureAvailability } from "./types.js";

const CHECK = "✅";
const CROSS = "❌";

export function generateDraftBlocks(feature: FeatureAvailability): DraftBlock[] {
  const blocks: DraftBlock[] = [];

  if (feature.plan && hasPlanRestriction(feature.plan)) {
    blocks.push({
      title: "Plan Availability",
      titleUrl: config.PLAN_DOC_URL,
      body: planSentence(feature.plan)
    });
  }

  if (feature.region && hasRegionRestriction(feature.region)) {
    blocks.push({
      title: "Region Availability",
      titleUrl: config.REGION_DOC_URL,
      body: regionSentence(feature.region)
    });
  }

  return blocks;
}

export function renderDraftMessage(feature: string, blocks: DraftBlock[], targetDocs: string[], confirmationCode?: string): string {
  const renderedBlocks = blocks
    .map((block) => `[${block.title}]\n${block.body}`)
    .join("\n\n");

  const renderedDocs = targetDocs.length > 0
    ? targetDocs.map((doc) => `- ${doc}`).join("\n")
    : "- No related docs found";

  return [
    `已根据 Source of truth 生成 ${feature} 的 availability 内容：`,
    "",
    renderedBlocks || "未发现 plan 或 region 限制，无需生成高亮块。",
    "",
    "将更新以下文档：",
    renderedDocs,
    "",
    confirmationCode
      ? `回复 ok ${confirmationCode} 后我会自动插入。`
      : "未找到可更新的相关文档。"
  ].join("\n");
}

function hasPlanRestriction(plan: FeatureAvailability["plan"]): boolean {
  if (!plan) return false;
  return [plan.standardSaas, plan.enterpriseSaas, plan.businessCriticalAndByoc].some((value) => !isFullSupport(value));
}

function hasRegionRestriction(region: FeatureAvailability["region"]): boolean {
  if (!region) return false;
  return [region.aws, region.googleCloud, region.azure].some((value) => !/✅\s*all regions/i.test(value.trim()));
}

function isFullSupport(value: string): boolean {
  return value.trim() === CHECK || /^✅\s*all/i.test(value.trim());
}

function planSentence(plan: NonNullable<FeatureAvailability["plan"]>): string {
  const supported: string[] = [];

  if (isSupported(plan.standardSaas)) supported.push("Standard (SaaS)");
  if (isSupported(plan.enterpriseSaas)) supported.push("Enterprise (SaaS)");
  supported.push(...resolveBusinessCriticalAndByocSupport(plan.businessCriticalAndByoc));

  if (supported.length === 0) {
    return "This feature is not available on the listed Zilliz Cloud plans.";
  }

  if (supported.length === 1) {
    return `This feature is available only on ${supported[0]}.`;
  }

  return `This feature is available only on ${joinEnglishList(supported)}.`;
}

function regionSentence(region: NonNullable<FeatureAvailability["region"]>): string {
  const parts: string[] = [];
  const unavailable: string[] = [];

  appendRegionSupport(parts, unavailable, "AWS", region.aws);
  appendRegionSupport(parts, unavailable, "Google Cloud", region.googleCloud);
  appendRegionSupport(parts, unavailable, "Microsoft Azure", region.azure);

  const sentences: string[] = [];
  if (parts.length > 0) {
    sentences.push(`This feature is available ${joinEnglishList(parts)}.`);
  }
  if (unavailable.length > 0) {
    sentences.push(`It is not available on ${joinEnglishList(unavailable)}.`);
  }

  return sentences.join(" ");
}

function appendRegionSupport(parts: string[], unavailable: string[], cloudName: string, value: string): void {
  const normalized = value.trim();
  if (normalized === CROSS) {
    unavailable.push(cloudName);
    return;
  }

  if (/✅\s*all regions/i.test(normalized)) {
    parts.push(`in all ${cloudName} regions`);
    return;
  }

  const regions = normalized
    .replace(/ℹ️/g, "")
    .replace(/Part of the regions:/i, "")
    .split(/\n|,|;/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  if (regions.length > 0) {
    parts.push(`in the following ${cloudName} regions: ${joinEnglishList(regions)}`);
  }
}

function isSupported(value: string): boolean {
  return value.includes(CHECK) && !value.includes(CROSS);
}

function resolveBusinessCriticalAndByocSupport(value: string): string[] {
  const supported: string[] = [];
  const businessCriticalMatch = value.match(/Business Critical:\s*(✅|❌)/i);
  const byocMatch = value.match(/BYOC:\s*(✅|❌)/i);

  if (businessCriticalMatch || byocMatch) {
    if (businessCriticalMatch?.[1] === CHECK) {
      supported.push("Business Critical (SaaS)");
    }
    if (byocMatch?.[1] === CHECK) {
      supported.push("BYOC deployments");
    }
    return supported;
  }

  if (isSupported(value)) {
    supported.push("Business Critical (SaaS)", "BYOC deployments");
  }

  return supported;
}

function joinEnglishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
