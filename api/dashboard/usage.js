import { sb } from "../_utils.js";

export default async function handler(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const todayRows = await sb(`
      select day, count
      from portal_ai_usage
      where day = '${today}'
    `);

    const last14 = await sb(`
      select day, count
      from portal_ai_usage
      order by day desc
      limit 14
    `);

    res.status(200).json({
      today: { count: todayRows?.[0]?.count ?? 0 },
      last14: last14 || [],
      limit: 30
    });

  } catch (err) {
    console.error("Usage Error:", err);
    res.status(500).json({ error: err.message });
  }
}
