// lib/supabase.js
//
// Safe Supabase service-role client used by workers.
// Prevents ALL "Unexpected end of JSON input" crashes.
//

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.warn("[sb] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
}

export async function sb(path, method = "GET", body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const options = {
    method,
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
    }
  };

  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let res;

  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error("[sb] Network error:", err.message);
    return null;
  }

  // Handles 204 No Content, empty bodies, HTML, errors, etc.
  const text = await res.text();

  if (!text || text.trim() === "") {
    return []; // safe fallback for SELECT
  }

  // If HTML comes through (Supabase outage, rate limit, proxy, etc.)
  if (text.startsWith("<")) {
    console.error("[sb] HTML response instead of JSON:", text.slice(0, 200));
    return [];
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("[sb] Failed to parse JSON:", text.slice(0, 200));
    return [];
  }
}
