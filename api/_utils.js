export async function sb(sql) {
  console.log("🔵 Running SQL:", sql);

  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`,
    {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sql })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.error("SQL ERROR:", text);
    throw new Error(text);
  }

  return await res.json();
}
