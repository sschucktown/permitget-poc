// lib/supabase.js
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn("[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars");
}

/**
 * Simple Supabase REST wrapper
 */
export async function sb(path, method = "GET", body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error [${res.status}]: ${text}`);
  }

  // 204 (no content)
  if (res.status === 204) return null;

  return res.json();
}
