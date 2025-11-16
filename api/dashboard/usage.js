import { sb } from "../_utils.js";

export default async function handler(req, res) {
  try {
    const today = new Date().toISOString().slice(0,10);

    const todaySql = `
      select count
      from portal_ai_usage
      where day = '${today}';
    `;

    const last14Sql = `
      select day, count
      from portal_ai_usage
      order by day desc
      limit 14;
    `;

    const todayData = await sb(todaySql);
    const last14 = await sb(last14Sql);

    res.status(200).json({
      today: { count: todayData?.[0]?.count ?? 0 },
      last14,
      limit: 30
    });

  } catch (err) {
    console.error("Usage Error:", err);
    res.status(500).json({ error: err.message });
  }
}
