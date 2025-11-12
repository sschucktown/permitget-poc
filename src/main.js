const SUPABASE_URL = "https://cavcbxixxbmruiuuguef.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNhdmNieGl4eGJtcnVpdXVndWVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkwMTYzOTUsImV4cCI6MjA3NDU5MjM5NX0.OcjmGQknChDocM6WC36yCwZjt5SMllC8HyOIEnBxl2w";

const form = document.getElementById("lookup-form");
const resultsDiv = document.getElementById("results");

async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Geocoding service error");
  const data = await res.json();
  if (!data.length) throw new Error("Address not found");
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function fetchPermits(lat, lon) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/permit_lookup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({ lat, lon })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Supabase error:", text);
    throw new Error("Supabase RPC error");
  }

  return await res.json();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  resultsDiv.innerHTML = `<p class="text-gray-500 animate-pulse">Loading...</p>`;

  try {
    const address = document.getElementById("address").value.trim();
    if (!address) throw new Error("Please enter an address");

    const geo = await geocodeAddress(address);
    const lat = parseFloat(geo.lat);
    const lon = parseFloat(geo.lon);

    if (isNaN(lat) || isNaN(lon)) throw new Error("Invalid coordinates");
    await new Promise(r => setTimeout(r, 200));

    const permits = await fetchPermits(lat, lon);

    if (!permits?.length) {
      resultsDiv.innerHTML = `<p class="text-gray-500">No jurisdictions found for this address.</p>`;
      return;
    }

    resultsDiv.innerHTML = permits.map(p => `
      <div class="border rounded p-3 bg-gray-50">
        <h2 class="font-semibold text-lg">${p.name} <span class="text-gray-500 text-sm">(${p.level})</span></h2>
        ${p.portal_url ? `
          <p class="mt-1">
            <a href="${p.portal_url}" target="_blank" class="text-blue-600 underline">Open Portal</a><br/>
            Method: ${p.submission_method ?? "n/a"}<br/>
            License Required: ${p.requires_license ? "Yes" : "No"}
          </p>
        ` : `<p class="text-gray-500 mt-1">No portal data available.</p>`}
      </div>
    `).join("");
  } catch (err) {
    console.error(err);
    resultsDiv.innerHTML = `<p class="text-red-600">${err.message}</p>`;
  }
});
