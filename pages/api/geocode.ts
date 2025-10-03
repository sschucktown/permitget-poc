import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const normalized = String(address).trim().toLowerCase();

  // Check cache
  const { data: cached } = await supabase
    .from('geocode_cache')
    .select('*')
    .eq('normalized_address', normalized)
    .maybeSingle();

  if (cached) return res.json(cached);

  // Geocode with Nominatim
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    String(address)
  )}&limit=1`;
  const response = await fetch(url, { headers: { 'User-Agent': 'permitget-poc' } });
  const results = await response.json();

  if (!results?.length) return res.status(404).json({ error: 'No results' });

  const r = results[0];
  const row = {
    raw_address: String(address),
    normalized_address: normalized,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    confidence: r.importance ?? null,
    source: 'nominatim',
  };

  await supabase.from('geocode_cache').insert(row);
  return res.json(row);
}
