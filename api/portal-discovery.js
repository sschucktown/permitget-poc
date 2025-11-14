// api/portal-discovery.js
export const config = {
  runtime: "nodejs",
};

import OpenAI from "openai";

// --------------------------
// Supabase helper
// --------------------------
async function sb(path, method = "GET", body = null) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Error: ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// --------------------------
// URL sanitation & vendor detection
// --------------------------
function normalizeURL(raw) {
  if (!raw) return null;
  let url = raw.trim();

  url = url.replace(/^```json/i, "")
           .replace(/^```/, "")
           .replace(/```$/, "")
           .trim();

  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  if (url.endsWith(".gov")) return url;

  const vendorDomains = [
    "accela", "energov", "etrakit",
    "citizenserve", "tylertech",
    "mygovernmentonline", "opengov",
    "viewpointcloud", "cityview"
  ];

  if (vendorDomains.some(v => url.toLowerCase().includes(v))) {
    return url;
  }

  return null;
}

function detectVendor(url) {
  if (!url) return null;

  const map = {
    accela: "accela",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    MGO: "mygovernmentonline",
    openGov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview",
  };

  for (const [vendor, keyword] of Object.entries(map)) {
    if (url.toLowerCase().includes(keyword)) return vendor;
  }

  if (url.endsWith(".gov")) return "municipal";
  return "unknown";
}

// --------------------------
// AI Portal Lookup
// --------------------------
async function discoverPortalWithAI(jurisdictionName) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = `
Find the official building permit portal for: "${jurisdictionName}"

RULES:
- Return ONLY a URL, nothing else.
- Must be a .gov or a known vendor portal (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO, ViewpointCloud)
- No PDFs
- No homepage links
- Prefer contractor login, permit portal, or permitting system
- Output EXACTLY one raw URL string
`;

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
  });

  let raw = "";
  try {
    raw = response.output[0]?.content[0]?.text?.value?.trim() ?? "";
  } catch (e) {
    raw = "";
  }

  return raw;
}

// --------------------------
// Main Worker Logic
// --------------------------
async function runWorker(req, res) {
  // 1. Get geoid + name from URL
  const url = new URL(req.url);
  const geoid = url.searchParams.get("geoid");
  const name = url.searchParams.get("name");

  if (!geoid || !name) {
    return res.status(400).json({ error: "Missing geoid or name" });
  }

  console.log(`🚀 Worker started for ${geoid} — ${name}`);

  // 2. Run AI search
  const aiRaw = await discoverPortalWithAI(name);
  const cleaned = normalizeURL(aiRaw);
  const vendor = detectVendor(cleaned);

  // 3. Save output to Supabase
  await sb("jurisdiction_meta", "POST", {
    jurisdiction_geoid: geoid,
    portal_url: cleaned,
    vendor_type: vendor,
    submission_method: cleaned ? "online" : "unknown",
    license_required: true,
    notes: aiRaw,
  });

  console.log("🎉 Worker successfully completed!", { cleaned, vendor });

  return res.status(200).json({
    geoid,
    name,
    discovered_url: cleaned,
    vendor,
    raw_ai_output: aiRaw,
  });
}

// --------------------------
// Vercel Handler (w/ Cron Auth)
// --------------------------
export default async function handler(req, res) {
  try {
    // Cron protection
    const auth = req.headers.get("authorization");
    if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return await runWorker(req, res);
  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message,
    });
  }
}
