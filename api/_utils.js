// api/_utils.js

/**
 * Execute raw SQL through Supabase RPC (exec_sql)
 * Always returns JSON array results.
 */

export async function sb(sql) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sql })
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`SQL Error: ${msg}`);
  }

  return res.json();
}
