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

    // Step 1: Geocode address → lon/lat
    const geoRes = await fetch(
      `${req.headers.origin}/api/geocode?address=${encodeURIComponent(String(address))}`
    );
    const geo = await geoRes.json();

    if (!geo?.lat || !geo?.lon) {
      return res.status(404).json({
        error: 'Geocoding failed',
        details: geo,
      });
    }

    const lon = parseFloat(geo.lon);
    const lat = parseFloat(geo.lat);
    const term = String(keyword).toLowerCase();

    // Step 2: Call Supabase RPC
    const { data, error } = await supabase.rpc('find_permit_resource_v2', {
      lon,
      lat,
      keyword: term,
    });

    if (error) {
      console.error('Supabase RPC error:', error);
      return res.status(500).json({
        error: 'Supabase RPC failed',
        details: error.message,
      });
    }

    // Step 3: Always return an array
    return res.status(200).json(data ?? []);
  } catch (err: any) {
    console.error('Unhandled error in /api/permits:', err);
    return res.status(500).json({
      error: 'Internal server error',
      details: err.message,
    });
  }
}
