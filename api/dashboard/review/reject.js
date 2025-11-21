// api/dashboard/review/reject.js
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

    const { id, manual_info_url, human_notes } = body;

    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    // 1) Load meta row
    const { data: metaRows, error: metaErr } = await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}&limit=1`
    );

    if (metaErr) {
      console.error("reject: meta fetch error", metaErr);
      return res.status(500).json({ error: "Failed to fetch meta" });
    }

    if (!metaRows || metaRows.length === 0) {
      return res.status(404).json({ error: "Meta row not found" });
    }

    const jm = metaRows[0];
    const now = new Date().toISOString();

    const finalManualInfoUrl =
      manual_info_url && manual_info_url.trim()
        ? manual_info_url.trim()
        : jm.manual_info_url || null;
    const finalHumanNotes =
      (human_notes && human_notes.trim()) || jm.human_notes || null;

    const hasManualInfo = !!finalManualInfoUrl;

    if (hasManualInfo) {
      // Human says: AI suggestion is wrong, but this jurisdiction is offline/manual-only.
      // Treat as "verified offline" rather than just invalid.
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

      await fetchSupabase(
        `jurisdiction_meta?id=eq.${id}`,
        "PATCH",
        {
          portal_url: null,
          manual_info_url: finalManualInfoUrl,
          human_notes: finalHumanNotes,
          vendor_type: "offline",
          submission_method: "offline_only",
          verified: true,
          verified_at: now,
          invalid: false,
          invalid_at: null
        }
      );

      // Mark other rows as invalid
      await fetchSupabase(
        `jurisdiction_meta?jurisdiction_geoid=eq.${jm.jurisdiction_geoid}&id=neq.${id}`,
        "PATCH",
        {
          invalid: true,
          invalid_at: now
        }
      );
    } else {
      // No manual_info_url: simple rejection of this AI attempt
      await fetchSupabase(
        `jurisdiction_meta?id=eq.${id}`,
        "PATCH",
        {
          invalid: true,
          invalid_at: now,
          human_notes: finalHumanNotes
        }
      );
    }

    return res.status(200).json({
      status: "ok",
      id,
      jurisdiction_geoid: jm.jurisdiction_geoid,
      manual_info_url: finalManualInfoUrl
    });
  } catch (err) {
    console.error("review/reject error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
