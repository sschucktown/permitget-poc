export async function fetchSupabase(path, method = "GET", body = null) {
  const url = process.env.SUPABASE_URL + "/rest/v1" + path;

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
    const text = await res.text();
    console.error("Supabase Error:", text);
    return {
      data: null,
      error: text
    };
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  return {
    data: json,
    error: null
  };
}
