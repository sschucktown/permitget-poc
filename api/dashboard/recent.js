import { sb } from "../_utils.js";

export default async function handler(req, res) {
  try {
    const sql = `
      select 
        jm.jurisdiction_geoid,
        j.name,
        jm.portal_url,
        jm.vendor_type,
        jm.updated_at
      from jurisdiction_meta jm
      join jurisdictions j
        on j.geoid = jm.jurisdiction_geoid
      order by jm.updated_at desc
      limit 20;
    `;

    const rows = await sb(sql);

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
