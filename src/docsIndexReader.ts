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
  };
};

const QUERY_FIELDS = [
  "Docs",
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

async function fetchMatchingDocsFromTable(tableId: string, featureName: string, identity: "bot" | "user"): Promise<RelatedDoc[]> {
  const filterJson = JSON.stringify(buildDocsIndexFilter(featureName));
  const args = [
    "base",
    "+record-list",
    "--base-token",
    config.DOCS_INDEX_BASE_TOKEN,
    "--table-id",
    tableId,
    "--as",
    identity,
    "--limit",
    "100",
    "--format",
    "json",
    "--filter-json",
    filterJson
  ];

  for (const field of QUERY_FIELDS) {
    args.push("--field-id", field);
  }

  const { stdout } = await execFileAsync("lark-cli", args, { maxBuffer: 20 * 1024 * 1024 });
  const result = JSON.parse(stdout) as RecordListResponse;
  if (!result.ok) {
    throw new Error(result.error?.message ?? `Failed to query docs index table ${tableId}.`);
  }

  const fields = result.data?.fields ?? [];
  const docsIndex = fields.indexOf("Docs");
  const placementTypeIndex = fields.indexOf("Placement Type");
  if (docsIndex < 0) {
    return [];
  }

  const records = result.data?.data ?? [];
  return records
    .map((row) => parseRelatedDocFromRecord(row, docsIndex, placementTypeIndex))
    .filter((doc): doc is RelatedDoc => Boolean(doc));
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
  const searchValues = dedupeStrings([normalized, slug, compact]);
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
  if (Array.isArray(placementType) && placementType.includes("section")) {
    return null;
  }

  const markdownMatch = rawDocs.match(/^\[(.+)\]\((https?:\/\/.+)\)$/);
  if (!markdownMatch) {
    return null;
  }

  const title = markdownMatch[1]?.trim();
  const url = markdownMatch[2]?.trim();
  if (!title || !url || !/^https?:\/\//i.test(url)) {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
