import { fetchSupabase } from "../_utils.js";

export default async function handler(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // today's usage
    const todayResp = await fetchSupabase(
      `/portal_ai_usage?day=eq.${today}&limit=1`,
      "GET"
    );

    const todayCount =
      todayResp.data?.[0]?.count !== undefined ? todayResp.data[0].count : 0;

    // last 14 days
    const last14 = await fetchSupabase(
      `/portal_ai_usage?order=day.desc&limit=14`,
      "GET"
    );

    return res.status(200).json({
      today: { count: todayCount },
      limit: 30,
      remaining: Math.max(0, 30 - todayCount),
      last14: last14.data ?? []
    });
  } catch (err) {
    console.error("Usage Error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
}

