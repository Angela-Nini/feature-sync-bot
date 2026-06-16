import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { readRelatedDocsFromBase } from "./docsIndexReader.js";
import { fetchFeishuDocContent } from "./larkDocClient.js";
import { parseFeatureMatrix } from "./matrixParser.js";
import type { FeatureAvailability } from "./types.js";

const execFileAsync = promisify(execFile);

export async function readFeatureAvailability(featureName: string): Promise<FeatureAvailability | null> {
  const [planContent, regionContent, relatedDocs] = await Promise.all([
    loadDocContent(config.PLAN_SOURCE_OF_TRUTH_DOC),
    loadDocContent(config.REGION_SOURCE_OF_TRUTH_DOC),
    readRelatedDocsFromBase(featureName)
  ]);

  const planMatch = parseFeatureMatrix(planContent, featureName);
  const regionMatch = parseFeatureMatrix(regionContent, featureName);

  if (!planMatch && !regionMatch) {
    return null;
  }

  return {
    feature: planMatch?.feature ?? regionMatch?.feature ?? featureName,
    plan: planMatch?.plan,
    region: regionMatch?.region,
    relatedDocs
  };
}

async function loadDocContent(docUrl: string): Promise<string> {
  if (config.SOURCE_OF_TRUTH_FIXTURE_PATH) {
    return readFile(path.resolve(config.SOURCE_OF_TRUTH_FIXTURE_PATH), "utf8");
  }

  if (config.LARK_APP_ID && config.LARK_APP_SECRET) {
    if (config.DOC_UPDATE_MODE === "cli") {
      try {
        return await fetchDocXmlWithLarkCli(docUrl);
      } catch (error) {
        console.warn(`Failed to fetch Source of Truth through lark-cli for ${docUrl}. Falling back to raw_content: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return fetchFeishuDocContent(docUrl);
  }

  return readFile(path.resolve("data/source-of-truth-sample.html"), "utf8");
}

async function fetchDocXmlWithLarkCli(docUrl: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("lark-cli", [
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--as",
    "bot",
    "--doc",
    docUrl,
    "--detail",
    "full",
    "--format",
    "json"
  ], { maxBuffer: 30 * 1024 * 1024 });

  if (stderr.trim()) {
    console.warn(stderr.trim());
  }

  const result = JSON.parse(stdout) as {
    ok?: boolean;
    error?: { message?: string };
    data?: { document?: { content?: string } };
  };

  if (!result.ok || typeof result.data?.document?.content !== "string") {
    throw new Error(result.error?.message ?? "lark-cli fetch failed");
  }

  return result.data.document.content;
}
