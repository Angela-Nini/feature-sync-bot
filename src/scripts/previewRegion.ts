import { previewRegionSupport } from "../regionWorkflow.js";
console.log(await previewRegionSupport(process.argv.slice(2).join(" ") || "Global Cluster"));
