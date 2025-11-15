import { fetchSupabase } from "../_utils.js";

export default async function handler(req, res) {
  const rows = await fetchSupabase(
    "jurisdictions_without_portals"
  );

  res.status(200).json({
    count: rows.length
  });
}
