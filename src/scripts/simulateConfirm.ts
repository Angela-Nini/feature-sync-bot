import { generateDraftBlocks } from "../draftGenerator.js";
import { readFeatureAvailability } from "../matrixReader.js";
import { updateRelatedDocs } from "../docUpdater.js";

const featureName = process.argv.slice(2).join(" ") || "Global Cluster";
const feature = await readFeatureAvailability(featureName);

if (!feature) {
  console.error(`Feature not found: ${featureName}`);
  process.exit(1);
}

const blocks = generateDraftBlocks(feature);
const result = await updateRelatedDocs(feature.relatedDocs, blocks);

console.log(JSON.stringify({
  feature: feature.feature,
  updated: result.updated.map((doc) => doc.title),
  failed: result.failed.map((item) => ({
    doc: item.doc.title,
    reason: item.reason
  }))
}, null, 2));
