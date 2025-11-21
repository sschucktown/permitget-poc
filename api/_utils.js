export async function fetchSupabase(path, method = "GET", body = null) {
  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!base || !serviceKey) {
    console.error("Supabase config missing:", { base, serviceKey });
    return { data: null, error: "Missing Supabase configuration" };
  }

  // Ensure path starts with a slash
  let cleanPath = path.startsWith("/") ? path : `/${path}`;

  // Auto-add select=* for GET requests unless already specified
  if (method === "GET" && !cleanPath.includes("select=")) {
    cleanPath += cleanPath.includes("?") ? "&select=*" : "?select=*";
  }

  // Build full URL
  const url = `${base}/rest/v1${cleanPath}`;
  console.log("FINAL_SUPABASE_URL:", url);

  // Prepare fetch options
  const options = {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  // Execute request
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkError) {
    console.error("Network / fetch error:", networkError);
    return { data: null, error: "Network error" };
  }

  // Handle Supabase errors cleanly
  if (!res.ok) {
    const text = await res.text();
    console.error("Supabase Error:", {
      status: res.status,
      statusText: res.statusText,
      detail: text
    });
    return { data: null, error: text };
  }

  // Parse JSON safely
  try {
    const json = await res.json();
    return { data: json, error: null };
  } catch (parseError) {
    console.error("JSON Parse Error:", parseError);
    return { data: null, error: "Invalid JSON from Supabase" };
  }
}
