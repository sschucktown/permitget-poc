import { fetchSupabase } from "../_utils.js";

export default async function handler(req, res) {
  try {
    // Count jurisdictions that still have NO portal metadata
    // (jurisdiction_meta rows must exist for a jurisdiction to be "completed")
    const { data, error } = await fetchSupabase(
      "/rpc/count_pending_jurisdictions",
      "POST"
    );

    if (error) throw error;

    return res.status(200).json({ count: data.count });
  } catch (err) {
    console.error("Pending Error:", err);
    res.status(500).json({ error: "server_error", message: err.message });
  }
}
