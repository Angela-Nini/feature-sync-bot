import { generateDraftBlocks, renderDraftMessage } from "../draftGenerator.js";
import { readFeatureAvailability } from "../matrixReader.js";

const featureName = process.argv.slice(2).join(" ") || "Global Cluster";
const feature = await readFeatureAvailability(featureName);

if (!feature) {
  console.error(`Feature not found: ${featureName}`);
  process.exit(1);
}

const blocks = generateDraftBlocks(feature);
console.log(renderDraftMessage(feature.feature, blocks, feature.relatedDocs.map((doc) => doc.title), "ABC123"));
