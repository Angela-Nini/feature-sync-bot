import { parse, HTMLElement } from "node-html-parser";
import type { FeatureAvailability, PlanAvailability, RegionAvailability, RelatedDoc } from "./types.js";

type Table = {
  headers: string[];
  rows: string[][];
  rawRows: HTMLElement[][];
};

export function parseFeatureMatrix(content: string, requestedFeature: string): FeatureAvailability | null {
  const root = parse(content);
  const tables = root.querySelectorAll("table").map(readTable).filter((table) => table.headers.length > 0);
  const planTable = tables.find((table) => hasHeaders(table, ["Feature", "Standard", "Enterprise", "Business"]));
  const regionTable = tables.find((table) => hasHeaders(table, ["Feature", "AWS", "Google", "Azure"]));

  const planMatch = planTable ? findFeatureRow(planTable, requestedFeature) : null;
  const regionMatch = regionTable ? findFeatureRow(regionTable, requestedFeature) : null;

  if (!planMatch && !regionMatch) {
    return parsePlainTextMatrix(content, requestedFeature);
  }

  const feature = planMatch?.feature ?? regionMatch?.feature ?? requestedFeature;
  const relatedDocs = mergeRelatedDocs([
    ...(planMatch?.relatedDocs ?? []),
    ...(regionMatch?.relatedDocs ?? [])
  ]);

  return {
    feature,
    plan: planMatch?.plan,
    region: regionMatch?.region,
    relatedDocs
  };
}

function parsePlainTextMatrix(content: string, requestedFeature: string): FeatureAvailability | null {
  const blocks = content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const planStart = findHeaderSequence(blocks, ["Feature", "Standard", "Enterprise", "Business Critical", "Related docs"]);
  const regionStart = findHeaderSequence(blocks, ["Feature", "AWS", "Google Cloud", "Microsoft Azure", "Related docs"]);

  const planSearchStart = planStart >= 0 ? planStart + 5 : -1;
  const planSearchEnd = regionStart >= 0 ? regionStart : blocks.length;
  const regionSearchStart = regionStart >= 0 ? regionStart + 5 : -1;

  const planMatch = planSearchStart >= 0
    ? findPlainFeatureRow(blocks, requestedFeature, planSearchStart, planSearchEnd, isPlanAvailabilityValue)
    : null;
  const regionMatch = regionSearchStart >= 0
    ? findPlainFeatureRow(blocks, requestedFeature, regionSearchStart, blocks.length, isRegionAvailabilityValue)
    : null;

  if (!planMatch && !regionMatch) return null;

  const feature = planMatch?.feature ?? regionMatch?.feature ?? requestedFeature;
  const relatedDocs = mergeRelatedDocs([
    ...(planMatch?.relatedDocs ?? []),
    ...(regionMatch?.relatedDocs ?? [])
  ]);

  return {
    feature,
    plan: planMatch ? {
      standardSaas: planMatch.values[0] ?? "",
      enterpriseSaas: planMatch.values[1] ?? "",
      businessCriticalAndByoc: planMatch.values[2] ?? ""
    } : undefined,
    region: regionMatch ? {
      aws: regionMatch.values[0] ?? "",
      googleCloud: regionMatch.values[1] ?? "",
      azure: regionMatch.values[2] ?? ""
    } : undefined,
    relatedDocs
  };
}

function findPlainFeatureRow(
  blocks: string[],
  requestedFeature: string,
  start: number,
  end: number,
  isValue: (value: string) => boolean
): { feature: string; values: string[]; relatedDocs: RelatedDoc[] } | null {
  let bestIndex = -1;
  let bestScore = 0;
  const requested = normalize(requestedFeature);

  for (let index = start; index < end; index += 1) {
    const score = matchScore(normalize(blocks[index] ?? ""), requested);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex < 0) return null;

  const values = [blocks[bestIndex + 1] ?? "", blocks[bestIndex + 2] ?? "", blocks[bestIndex + 3] ?? ""];
  if (!values.every(isValue)) return null;

  const relatedCandidate = blocks[bestIndex + 4];
  const nextRowStartsAtCandidate = [blocks[bestIndex + 5], blocks[bestIndex + 6], blocks[bestIndex + 7]].every((value) => (
    typeof value === "string" && isValue(value)
  ));
  const nextRowStartsAfterCandidate = [blocks[bestIndex + 6], blocks[bestIndex + 7], blocks[bestIndex + 8]].every((value) => (
    typeof value === "string" && isValue(value)
  ));

  const relatedDocs = relatedCandidate && !nextRowStartsAtCandidate && nextRowStartsAfterCandidate
    ? [{ title: relatedCandidate }]
    : [];

  return {
    feature: blocks[bestIndex] ?? requestedFeature,
    values,
    relatedDocs
  };
}

function findHeaderSequence(blocks: string[], expected: string[]): number {
  for (let index = 0; index <= blocks.length - expected.length; index += 1) {
    const matched = expected.every((header, offset) => normalize(blocks[index + offset] ?? "").includes(normalize(header)));
    if (matched) return index;
  }
  return -1;
}

function isPlanAvailabilityValue(value: string): boolean {
  return /✅|❌|--|%|business critical|byoc/i.test(value);
}

function isRegionAvailabilityValue(value: string): boolean {
  return /✅|❌|all regions|part of the regions|^[a-z]+-[a-z]+-\d+/i.test(value);
}

function readTable(table: HTMLElement): Table {
  const trs = table.querySelectorAll("tr");
  const rows = trs.map((tr) => tr.querySelectorAll("td, th"));
  const textRows = rows.map((cells) => cells.map(cellText));
  const headers = textRows[0] ?? [];
  return {
    headers,
    rows: textRows.slice(1),
    rawRows: rows.slice(1)
  };
}

function findFeatureRow(table: Table, requestedFeature: string): {
  feature: string;
  plan?: PlanAvailability;
  region?: RegionAvailability;
  relatedDocs: RelatedDoc[];
} | null {
  const featureIndex = findHeaderIndex(table.headers, "Feature");
  if (featureIndex < 0) return null;

  let bestRow: string[] | null = null;
  let bestRawRow: HTMLElement[] | null = null;
  let bestScore = 0;
  const requested = normalize(requestedFeature);

  for (const [index, row] of table.rows.entries()) {
    const score = matchScore(normalize(row[featureIndex] ?? ""), requested);
    if (score > bestScore) {
      bestRow = row;
      bestRawRow = table.rawRows[index];
      bestScore = score;
    }
  }

  if (!bestRow || !bestRawRow) return null;

  const row = bestRow;
  const rawRow = bestRawRow;
  const relatedDocsIndex = findHeaderIndex(table.headers, "Related docs");
  const relatedDocs = relatedDocsIndex >= 0 ? extractRelatedDocs(rawRow[relatedDocsIndex]) : [];

  const standardIndex = findHeaderIndex(table.headers, "Standard");
  const enterpriseIndex = findHeaderIndex(table.headers, "Enterprise");
  const businessIndex = findHeaderIndex(table.headers, "Business");
  const awsIndex = findHeaderIndex(table.headers, "AWS");
  const gcpIndex = findHeaderIndex(table.headers, "Google");
  const azureIndex = findHeaderIndex(table.headers, "Azure");

  const result = {
    feature: row[featureIndex],
    relatedDocs
  } as {
    feature: string;
    plan?: PlanAvailability;
    region?: RegionAvailability;
    relatedDocs: RelatedDoc[];
  };

  if (standardIndex >= 0 && enterpriseIndex >= 0 && businessIndex >= 0) {
    result.plan = {
      standardSaas: row[standardIndex] ?? "",
      enterpriseSaas: row[enterpriseIndex] ?? "",
      businessCriticalAndByoc: row[businessIndex] ?? ""
    };
  }

  if (awsIndex >= 0 && gcpIndex >= 0 && azureIndex >= 0) {
    result.region = {
      aws: row[awsIndex] ?? "",
      googleCloud: row[gcpIndex] ?? "",
      azure: row[azureIndex] ?? ""
    };
  }

  return result;
}

function cellText(cell?: HTMLElement): string {
  if (!cell) return "";

  const listItems = cell.querySelectorAll("li").map((li) => li.text.trim()).filter(Boolean);
  if (listItems.length > 0) {
    const withoutList = cell.clone() as HTMLElement;
    withoutList.querySelectorAll("ul, ol").forEach((node: HTMLElement) => node.remove());
    const prefix = withoutList.text.trim();
    return [prefix, ...listItems].filter(Boolean).join("\n");
  }

  return cell.text.replace(/\s+/g, " ").trim();
}

function extractRelatedDocs(cell?: HTMLElement): RelatedDoc[] {
  if (!cell) return [];

  const docs: RelatedDoc[] = [];

  cell.querySelectorAll("cite").forEach((cite) => {
    const title = cite.getAttribute("title");
    const docId = cite.getAttribute("doc-id");
    if (title || docId) {
      docs.push({
        title: title ?? docId ?? "Untitled doc",
        docId: docId ?? undefined,
        url: docId ? `https://zilliverse.feishu.cn/wiki/${docId}` : undefined
      });
    }
  });

  cell.querySelectorAll("a").forEach((a) => {
    const title = a.text.trim();
    const url = a.getAttribute("href");
    if (title || url) {
      docs.push({
        title: title || url || "Untitled doc",
        url: url ?? undefined
      });
    }
  });

  return mergeRelatedDocs(docs);
}

function mergeRelatedDocs(docs: RelatedDoc[]): RelatedDoc[] {
  const seen = new Set<string>();
  const merged: RelatedDoc[] = [];
  for (const doc of docs) {
    const key = doc.docId ?? doc.url ?? doc.title;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
  }
  return merged;
}

function hasHeaders(table: Table, expected: string[]): boolean {
  const headers = table.headers.map(normalize).join(" ");
  return expected.every((header) => headers.includes(normalize(header)));
}

function findHeaderIndex(headers: string[], name: string): number {
  const target = normalize(name);
  return headers.findIndex((header) => normalize(header).includes(target));
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchScore(candidate: string, requested: string): number {
  if (!candidate || !requested) return 0;
  if (candidate === requested) return 100;
  if (candidate.includes(requested) || requested.includes(candidate)) return 80;

  const requestedTokens = new Set(requested.split(/\s+/).filter(Boolean));
  const candidateTokens = new Set(candidate.split(/\s+/).filter(Boolean));
  const overlap = [...requestedTokens].filter((token) => candidateTokens.has(token)).length;
  return overlap === requestedTokens.size ? 60 : 0;
}
