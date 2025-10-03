// pages/api/permits.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { address, keyword } = req.query;

    if (!address || !keyword) {
      return res.status(400).json({ error: 'Missing address or keyword' });
    }

    // ✅ Step 1: Geocode directly via Nominatim
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        String(address)
      )}`,
      {
        headers: {
          'User-Agent': 'PermitGet/1.0 (contact@permitget.com)',
        },
      }
    );

    if (!geoRes.ok) {
      return res.status(502).json({ error: 'Geocoding service failed' });
    }

    const results = await geoRes.json();
    const geo = results?.[0];

    if (!geo?.lat || !geo?.lon) {
      return res.status(404).json({ error: 'Geocoding failed', details: results });
    }

    const lon = parseFloat(geo.lon);
    const lat = parseFloat(geo.lat);
    const term = String(keyword).toLowerCase();

    // 🔎 Debug log for Vercel
    console.log("RPC params", { lon, lat, keyword: term });

    // ✅ Step 2: Call Supabase RPC
    const { data, error } = await supabase.rpc('find_permit_resource_v2', {
      lon,
      lat,
      keyword: term,
    });

    console.log("RPC result", { data, error });

    if (error) {
      return res.status(500).json({
        error: 'Supabase RPC failed',
        details: error.message,
      });
    }

    // ✅ Step 3: Always return an array
    return res.status(200).json(data ?? []);
  } catch (err: any) {
    console.error('Unhandled error in /api/permits:', err);
    return res.status(500).json({
      error: 'Internal server error',
      details: err.message,
    });
  }
}
