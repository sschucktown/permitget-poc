import { fetchSupabase } from "../_utils.js";

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  const rows = await fetchSupabase(
    `portal_ai_usage?day=eq.${today}&limit=1`
  );

  const used = rows?.[0]?.count || 0;
  const limit = parseInt(process.env.DAILY_AI_LIMIT || "25", 10);

  res.status(200).json({
    used,
    remaining: Math.max(0, limit - used),
    limit
  });
}
