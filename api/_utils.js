// api/_utils.js

export async function sb(sql) {
  console.log("🔵 Running SQL:", sql);

  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`;
  console.log("🔵 Calling RPC URL:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sql })
  });

  console.log("🟡 RPC status:", res.status);

  if (!res.ok) {
    const errText = await res.text();
    console.error("🔴 SQL RPC Error Response:", errText);
    throw new Error(`SQL Error: ${errText}`);
  }

  const json = await res.json();
  console.log("🟢 RPC result:", json);

  return json;
}

