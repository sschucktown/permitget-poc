// api/dashboard/review/reject.js
import { fetchSupabase } from "../../_utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { id } = JSON.parse(req.body || "{}");
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    const now = new Date().toISOString();

    await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}`,
      "PATCH",
      {
        invalid: true,
        invalid_at: now
      }
    );

    return res.status(200).json({ status: "ok", id });
  } catch (err) {
    console.error("review/reject error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
