import express from "express";
import { config } from "./config.js";
import { handleFeishuEvent } from "./eventHandler.js";

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/feishu/events", (_req, res) => {
  res.json({ ok: true });
});

app.post("/feishu/events", async (req, res) => {
  try {
    const response = await handleFeishuEvent(req.body);
    res.json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `No route for ${req.method} ${req.path}`
  });
});

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`Feature Sync Bot listening on http://${config.HOST}:${config.PORT}`);
});

server.on("error", (error) => {
  console.error("HTTP server error:", error);
  process.exitCode = 1;
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
