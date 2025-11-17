// api/dashboard/review/approve.js
import { fetchSupabase } from "../../_utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { id } = JSON.parse(req.body || "{}");
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    // 1) Get the jurisdiction_meta row
    const metaRows = await fetchSupabase(`jurisdiction_meta?id=eq.${id}&limit=1`);
    if (!metaRows || metaRows.length === 0) {
      return res.status(404).json({ error: "Not found" });
    }

    const jm = metaRows[0];
    const canonicalUrl =
      jm.portal_url ||
      (jm.raw_ai_output && jm.raw_ai_output.url) ||
      null;

    const now = new Date().toISOString();

    // 2) Update jurisdictions with the chosen official portal
    if (canonicalUrl) {
      await fetchSupabase(
        `jurisdictions?geoid=eq.${jm.jurisdiction_geoid}`,
        "PATCH",
        {
          portal_url: canonicalUrl,
          submission_method: "online",
          requires_license: jm.license_required ?? true,
          updated_at: now
        }
      );
    }

    // 3) Mark this meta row as verified
    await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}`,
      "PATCH",
      {
        verified: true,
        verified_at: now,
        portal_url: canonicalUrl
      }
    );

    // 4) Optionally mark all *other* rows for this jurisdiction as invalid
    await fetchSupabase(
      `jurisdiction_meta?jurisdiction_geoid=eq.${jm.jurisdiction_geoid}&id=neq.${id}`,
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
