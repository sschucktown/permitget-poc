import { sb } from "../_utils.js";

export default async function handler(req, res) {
  try {
    const sql = `
      select jurisdiction_geoid, portal_url, vendor_type, notes, updated_at
      from jurisdiction_meta
      order by updated_at desc
      limit 20;
    `;

    const rows = await sb(sql);

    // Compute vendor breakdown
    const vendorBreakdown = {};
    rows.forEach(r => {
      const v = r.vendor_type ?? "unknown";
      vendorBreakdown[v] = (vendorBreakdown[v] || 0) + 1;
    });

    res.status(200).json({
      rows,
      vendorBreakdown
    });

  } catch (err) {
    console.error("Recent Error:", err);
    res.status(500).json({ error: err.message });
  }
}
