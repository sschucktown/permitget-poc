// api/portal-discovery.js
import { runPortalDiscovery } from "../lib/portalDiscoveryPipeline.js";

export default async function handler(req, res) {
  try {
    const { geoid, force } = req.query;

    if (!geoid) {
      res.status(400).json({ error: "Missing geoid" });
      return;
    }

    const forceRefresh = force === "true" || force === "1";

    const result = await runPortalDiscovery({ geoid, forceRefresh });

    res.status(200).json({
      geoid,
      ...result
    });
  } catch (err) {
    console.error("[portal-discovery] error:", err);

    // Handle quota errors cleanly instead of "crash"
    if (err.status === 429 || err.code === "insufficient_quota") {
      res.status(503).json({
        error: "OpenAI quota exceeded",
        code: "OPENAI_QUOTA",
        message: err.error?.message || err.message
      });
      return;
    }

    res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}
