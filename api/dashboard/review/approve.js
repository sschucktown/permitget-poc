// api/dashboard/review/approve.js
import { fetchSupabase } from "../../_utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Vercel gives req.body already parsed JSON
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    // 1) Get the jurisdiction_meta row
    const metaRes = await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}&limit=1&select=*`
    );

    if (!metaRes || !Array.isArray(metaRes.data) || metaRes.data.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const jm = metaRes.data[0];

    const canonicalUrl =
      jm.portal_url ||
      (jm.raw_ai_output && jm.raw_ai_output.url) ||
      null;

    const now = new Date().toISOString();

    // 2) Update the jurisdictions table
    if (canonicalUrl) {
      await fetchSupabase(
        `jurisdictions?geoid=eq.${jm.jurisdiction_geoid}&select=id`,
        "PATCH",
        {
          portal_url: canonicalUrl,
          submission_method: "online",
          requires_license: jm.license_required ?? true,
          updated_at: now
        }
      );
    }

    // 3) Mark THIS meta row as verified
    await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}&select=id`,
      "PATCH",
      {
        verified: true,
        verified_at: now,
        portal_url: canonicalUrl
      }
    );

    // 4) Mark *other* meta rows for same jurisdiction as invalid
    await fetchSupabase(
      `jurisdiction_meta?jurisdiction_geoid=eq.${jm.jurisdiction_geoid}&id=neq.${id}&select=id`,
      "PATCH",
      {
        invalid: true,
        invalid_at: now
      }
    );

    return res.status(200).json({
      status: "ok",
      id,
      jurisdiction_geoid: jm.jurisdiction_geoid,
      portal_url: canonicalUrl
    });

  } catch (err) {
    console.error("review/approve error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
