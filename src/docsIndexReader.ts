import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { RelatedDoc } from "./types.js";

const execFileAsync = promisify(execFile);

type TableListResponse = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    tables?: Array<{ id?: string; name?: string }>;
  };
};

type RecordListResponse = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    data?: Array<Array<string | string[] | null>>;
    fields?: string[];
    record_id_list?: string[];
    has_more?: boolean;
  };
};

const QUERY_FIELDS = [
  "Docs",
  "Parent",
  "Slug",
  "Alias1",
  "Alias2",
  "Keywords",
  "Labels",
  "Progress",
  "Placement Type"
] as const;

export async function readRelatedDocsFromBase(featureName: string): Promise<RelatedDoc[]> {
  if (!config.DOCS_INDEX_BASE_TOKEN) {
    return [];
  }

  const identity = await resolveDocsIndexIdentity();
  const tables = await fetchDocsIndexTables(identity);
  const results: RelatedDoc[] = [];

  for (const table of tables) {
    const docs = await withRateLimitRetry(() => fetchMatchingDocsFromTable(table.id, featureName, identity));
    results.push(...docs);
  }

  return dedupeDocs(results);
}

async function fetchDocsIndexTables(identity: "bot" | "user"): Promise<Array<{ id: string; name: string }>> {
  const { stdout } = await execFileAsync("lark-cli", [
    "base",
    "+table-list",
    "--base-token",
    config.DOCS_INDEX_BASE_TOKEN,
    "--as",
    identity,
    "--format",
    "json"
  ], { maxBuffer: 10 * 1024 * 1024 });

  const result = JSON.parse(stdout) as TableListResponse;
  if (!result.ok) {
    throw new Error(result.error?.message ?? "Failed to list docs index tables.");
  }

  return (result.data?.tables ?? [])
    .filter((table): table is { id: string; name: string } => Boolean(table.id && table.name));
}

type IndexCell = string | string[] | Array<{ id: string }> | null;
type IndexRow = { id: string; fields: string[]; cells: IndexCell[] };

async function queryRows(tableId: string, filter: unknown, identity: "bot" | "user"): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const args = ["base", "+record-list", "--base-token", config.DOCS_INDEX_BASE_TOKEN,
      "--table-id", tableId, "--as", identity, "--limit", "100", "--offset", String(offset),
      "--format", "json", "--filter-json", JSON.stringify(filter)];
    for (const field of QUERY_FIELDS) args.push("--field-id", field);
    const { stdout } = await execFileAsync("lark-cli", args, { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
    const result = JSON.parse(stdout) as RecordListResponse;
    if (!result.ok) throw new Error(result.error?.message ?? `Failed to query ${tableId}`);
    const data = result.data;
    if (!data?.fields?.includes("Docs") || !data.fields.includes("Parent") || !data.fields.includes("Placement Type")) {
      throw new Error(`Missing required index fields in ${tableId}`);
    }
    const page = data.data ?? [];
    if (page.length !== (data.record_id_list ?? []).length) throw new Error("Missing record identifiers");
    page.forEach((cells, i) => rows.push({ id: data.record_id_list![i], fields: data.fields!, cells }));
    if (!data.has_more) break;
    if (!page.length) throw new Error("Index pagination returned an empty incomplete page");
  }
  return rows;
}

function rowValue(row: IndexRow, field: string): IndexCell | undefined {
  return row.cells[row.fields.indexOf(field)];
}

export function isFeatureSection(row: { title: string; slug: string; placement: string[] }, feature: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return row.placement.includes("section") && (normalize(row.title) === normalize(feature) || normalize(row.slug) === normalize(feature));
}

async function fetchMatchingDocsFromTable(tableId: string, featureName: string, identity: "bot" | "user"): Promise<RelatedDoc[]> {
  const matches = await queryRows(tableId, buildDocsIndexFilter(featureName), identity);
  const sections = matches.filter(row => {
    const docs = rowValue(row, "Docs");
    const title = typeof docs === "string" ? docs.match(/^\[([^\]]+)\]/)?.[1] ?? "" : "";
    return isFeatureSection({ title, slug: String(rowValue(row, "Slug") ?? ""), placement: rowValue(row, "Placement Type") as string[] ?? [] }, featureName);
  });
  const selected = new Map<string, IndexRow>();
  if (sections.length > 1) throw new Error(`Multiple feature sections in ${tableId}; review scope before proceeding`);
  if (sections.length) {
    const queue = sections.map(row => row.id);
    const visited = new Set<string>();
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      const children = await queryRows(tableId, { logic: "and", conditions: [["Parent", "intersects", [{ id: parent }]]] }, identity);
      for (const child of children) {
        selected.set(child.id, child);
        if (!visited.has(child.id)) queue.push(child.id);
      }
    }
  } else {
    // Without a dedicated section, keyword matches remain candidates for preview.
    matches.forEach(row => selected.set(row.id, row));
  }
  return [...selected.values()].map(row => parseRelatedDocFromRecord(
    row.cells as Array<string | string[] | null>, row.fields.indexOf("Docs"), row.fields.indexOf("Placement Type")
  )).filter((doc): doc is RelatedDoc => Boolean(doc));
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimited = /OpenAPIListRecord limited|800004135/i.test(message);
      if (!isRateLimited || attempt === maxAttempts) {
        throw error;
      }

      await sleep(500 * attempt);
    }
  }

  throw new Error("Unexpected retry flow.");
}

async function resolveDocsIndexIdentity(): Promise<"bot" | "user"> {
  if (config.DOCS_INDEX_IDENTITY === "user") {
    return "user";
  }

  try {
    await fetchDocsIndexTables("bot");
    return "bot";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission|91403/i.test(message)) {
      throw error;
    }

    console.warn("Docs index bot access denied. Falling back to user identity for Base reads.");
    return "user";
  }
}

function buildDocsIndexFilter(featureName: string): { logic: "or"; conditions: Array<[string, "intersects", string]> } {
  const normalized = featureName.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const compact = normalized.replace(/\s+/g, "");
  const searchValues = dedupeStrings([featureName.trim(), normalized, slug, compact]);
  const searchableFields = ["Docs", "Slug", "Alias1", "Alias2", "Keywords", "Labels"];

  return {
    logic: "or",
    conditions: searchableFields.flatMap((field) => searchValues.map((value) => [field, "intersects", value] as [string, "intersects", string]))
  };
}

function parseRelatedDocFromRecord(
  row: Array<string | string[] | null>,
  docsIndex: number,
  placementTypeIndex: number
): RelatedDoc | null {
  const rawDocs = row[docsIndex];
  if (typeof rawDocs !== "string") {
    return null;
  }

  const placementType = row[placementTypeIndex];
  if (!isCanonicalPlacement(placementType)) {
    return null;
  }

  const markdownMatch = rawDocs.match(/^\[(.+)\]\((https?:\/\/.+)\)$/);
  if (!markdownMatch) {
    return null;
  }

  const title = markdownMatch[1]?.trim();
  const url = markdownMatch[2]?.trim();
  if (!title || !url || !/^https:\/\/zilliverse\.feishu\.cn\/(wiki|docx)\//i.test(url)) {
    return null;
  }

  return {
    title,
    url,
    docId: parseDocIdFromUrl(url)
  };
}

function parseDocIdFromUrl(url: string): string | undefined {
  const wikiMatch = url.match(/\/wiki\/([^/?#]+)/);
  if (wikiMatch?.[1]) return wikiMatch[1];

  const docxMatch = url.match(/\/docx\/([^/?#]+)/);
  if (docxMatch?.[1]) return docxMatch[1];

  return undefined;
}

function dedupeDocs(docs: RelatedDoc[]): RelatedDoc[] {
  const seen = new Set<string>();
  const deduped: RelatedDoc[] = [];

  for (const doc of docs) {
    const key = doc.docId ?? doc.url ?? doc.title;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(doc);
  }

  return deduped;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isCanonicalPlacement(value: string | string[] | null | undefined): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item === "canonical");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
