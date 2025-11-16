import { sb } from "../_utils.js";

export default async function handler(req, res) {
  try {
    const sql = `
      select count(*) as count
      from jurisdictions_without_portals;
    `;

    const data = await sb(sql);

    res.status(200).json({
      count: data?.[0]?.count ?? 0
    });
  } catch (err) {
    console.error("Pending Error:", err);
    res.status(500).json({ error: err.message });
  }
}
