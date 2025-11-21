// api/dashboard/review/approve.js
import { fetchSupabase } from "../../_utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    let body = {};
    try {
      body =
        typeof req.body === "string"
          ? JSON.parse(req.body || "{}")
          : (req.body || {});
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { id, portal_url, manual_info_url, human_notes } = body;

    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    // 1) Load meta row
    const { data: metaRows, error: metaErr } = await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}&limit=1`
    );

    if (metaErr) {
      console.error("approve: meta fetch error", metaErr);
      return res.status(500).json({ error: "Failed to fetch meta" });
    }

    if (!metaRows || metaRows.length === 0) {
      return res.status(404).json({ error: "Meta row not found" });
    }

    const jm = metaRows[0];
    const now = new Date().toISOString();

    // 2) Compute final portal URL
    const aiUrl =
      jm.portal_url ||
      (jm.raw_ai_output && jm.raw_ai_output.url) ||
      (jm.raw_ai_output && jm.raw_ai_output.url?.trim && jm.raw_ai_output.url.trim()) ||
      null;

    const finalPortalUrl = (portal_url && portal_url.trim()) || aiUrl || null;
    const finalManualInfoUrl =
      manual_info_url && manual_info_url.trim()
        ? manual_info_url.trim()
        : jm.manual_info_url || null;
    const finalHumanNotes =
      (human_notes && human_notes.trim()) || jm.human_notes || null;

    const hasPortal = !!finalPortalUrl;
    const hasManualInfo = !!finalManualInfoUrl;

    // 3) Update jurisdictions based on classification
    if (hasPortal) {
      // Online portal confirmed
      await fetchSupabase(
        `jurisdictions?geoid=eq.${jm.jurisdiction_geoid}`,
        "PATCH",
        {
          portal_url: finalPortalUrl,
          submission_method: "online",
          requires_license: jm.license_required ?? null,
          updated_at: now
        }
      );
    } else if (hasManualInfo) {
      // Offline PDF/manual-only jurisdiction
      await fetchSupabase(
        `jurisdictions?geoid=eq.${jm.jurisdiction_geoid}`,
        "PATCH",
        {
          portal_url: null,
          submission_method: "offline_only",
          requires_license: jm.license_required ?? null,
          updated_at: now
        }
      );
    } else {
      // No portal and no manual info URL: just mark verified but don’t change jurisdiction record
    }

    // 4) Update this meta row as verified
    await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}`,
      "PATCH",
      {
        portal_url: hasPortal ? finalPortalUrl : null,
        manual_info_url: finalManualInfoUrl,
        human_notes: finalHumanNotes,
        verified: true,
        verified_at: now,
        invalid: false,
        invalid_at: null
      }
    );

    // 5) Mark all *other* meta rows for this jurisdiction as invalid
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
      portal_url: finalPortalUrl,
      manual_info_url: finalManualInfoUrl
    });
  } catch (err) {
    console.error("review/approve error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
