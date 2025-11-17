// api/dashboard/review/approve.js
import { fetchSupabase } from "../../_utils.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Vercel gives req.body already parsed JSON
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    // 1) Get the jurisdiction_meta row
    const metaRes = await fetchSupabase(
      `jurisdiction_meta?id=eq.${id}&limit=1&select=*`
    );

    if (!metaRes || !Array.isArray(metaRes.data) || metaRes.
