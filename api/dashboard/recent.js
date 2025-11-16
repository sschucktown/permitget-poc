import { fetchSupabase } from "../_utils.js";

export default async function handler(req, res) {
  try {
    // Pull last 20 jurisdiction_meta entries
    const recent = await fetchSupabase(
      "/jurisdiction_meta?order=created_at.desc&limit=20",
      "GET"
    );

    const rows = recent.data ?? [];

    // vendor breakdown
    const vendorBreakdown = rows.reduce((acc, row) => {
      const vendor = row.vendor_type || "unknown";
      acc[vendor] = (acc[vendor] || 0) + 1;
      return acc;
    }, {});

    // Attach jurisdiction names
    const fullRows = [];

    for (const r of rows) {
      const j = await fetchSupabase(
        `/jurisdictions?geoid=eq.${r.jurisdiction_geoid}&limit=1`,
        "GET"
      );

      fullRows.push({
        ...r,
        name: j.data?.[0]?.name ?? r.jurisdiction_geoid
      });
    }

    return res.status(200).json({
      rows: fullRows,
      vendorBreakdown
    });
  } catch (err) {
    console.error("Recent Error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
}
