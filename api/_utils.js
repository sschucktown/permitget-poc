export async function fetchSupabase(path, method = "GET", body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    throw new Error("Supabase error: " + (await res.text()));
  }

  try { return await res.json(); }
  catch { return []; }
}
