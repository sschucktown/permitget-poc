import { fetchSupabase } from "../_utils.js";

export default async function handler(req, res) {
  const rows = await fetchSupabase(
    "jurisdiction_meta?order=updated_at.desc&limit=20"
  );

  res.status(200).json({ rows });
}
