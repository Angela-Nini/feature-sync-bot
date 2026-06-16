import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { fetchFeishuDocContent } from "./larkDocClient.js";
import { parseFeatureMatrix } from "./matrixParser.js";
import type { FeatureAvailability } from "./types.js";

const execFileAsync = promisify(execFile);

export async function readFeatureAvailability(featureName: string): Promise<FeatureAvailability | null> {
  const content = await loadSourceOfTruthContent();
  return parseFeatureMatrix(content, featureName);
}

async function loadSourceOfTruthContent(): Promise<string> {
  if (config.SOURCE_OF_TRUTH_FIXTURE_PATH) {
    return readFile(config.SOURCE_OF_TRUTH_FIXTURE_PATH, "utf8");
  }

  if (config.LARK_APP_ID && config.LARK_APP_SECRET) {
    if (config.DOC_UPDATE_MODE === "cli") {
      try {
        return await fetchSourceOfTruthXmlWithLarkCli();
      } catch (error) {
        console.warn(`Failed to fetch Source of Truth through lark-cli. Falling back to raw_content: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return fetchFeishuDocContent(config.SOURCE_OF_TRUTH_DOC);
  }

  // Keep a built-in sample so the parser and chat flow can be tested before
  // Feishu credentials are configured.
  return readFile(path.resolve("data/source-of-truth-sample.html"), "utf8");
}

async function fetchSourceOfTruthXmlWithLarkCli(): Promise<string> {
  const { stdout, stderr } = await execFileAsync("lark-cli", [
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--as",
    "bot",
    "--doc",
    config.SOURCE_OF_TRUTH_DOC,
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
