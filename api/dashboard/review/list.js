// api/dashboard/review/list.js
import { fetchSupabase } from "../../_utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const limit = parseInt(req.query.limit || "25", 10);
    const offset = parseInt(req.query.offset || "0", 10);

    const path = `jurisdiction_review_queue?order=created_at.desc&limit=${limit}&offset=${offset}`;

    let data = await fetchSupabase(path);

    // --- Safety guards ---
    if (data == null) data = [];
    if (Array.isArray(data.data)) data = data.data;
    if (!Array.isArray(data)) data = [];

    return res.status(200).json({ rows: data });
  } catch (err) {
    console.error("review/list error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
