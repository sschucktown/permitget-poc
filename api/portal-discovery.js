import { runPortalDiscovery } from "./portalDiscovery.js";

export default async function handler(req, res) {
  try {
    console.log("🚀 Portal Discovery triggered");
    const result = await runPortalDiscovery();
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.toString() });
  }
}
