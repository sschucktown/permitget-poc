import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { address, keyword } = req.query;
  if (!address || !keyword) return res.status(400).json({ error: 'Need address and keyword' });

  // Call geocode first
  const geoRes = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/geocode?address=${encodeURIComponent(String(address))}`);
  const geo = await geoRes.json();
  if (!geo?.lat || !geo?.lon) return res.status(404).json({ error: 'Geocoding failed' });

  // Call Supabase RPC
  const { data, error } = await supabase.rpc('find_permit_resource', {
    lon: geo.lon,
    lat: geo.lat,
    keyword: String(keyword),
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
}
