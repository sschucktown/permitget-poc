import { runPortalDiscovery } from "./portalDiscovery.js";

export default async function handler(req, res) {
  console.log("🚀 Portal Discovery API invoked");

  try {
    const result = await runPortalDiscovery();

    return res.status(200).json({
      ok: true,
      result,
    });

  } catch (err) {
    console.error("❌ Portal Discovery Crash:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack,
    });
  }
}
