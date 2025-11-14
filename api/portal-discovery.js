// api/portal-discovery.js

import OpenAI from "openai";

// FORCE Node.js (Edge cannot load OpenAI SDK)
export const config = {
  runtime: "nodejs"
};

// ------------------------------------------------------------
// ENV VARS
// ------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------------------------------------
// Supabase wrapper (Node native fetch)
// ------------------------------------------------------------
async function sb(path, method = "GET", body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Supabase Error: ${t}`);
  }
  return res.json();
}

// ------------------------------------------------------------
// URL Validator
// ------------------------------------------------------------
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const vendors = [
    "accela.com",
    "energov",
    "etrakit",
    "citizenserve.com",
    "tylertech.com",
    "mygovernmentonline.org",
    "opengov",
    "viewpointcloud",
    "cityview"
  ];

  const u = url.toLowerCase();

  if (u.endsWith(".gov")) return url;
  if (vendors.some(v => u.includes(v))) return url;

  return null;
}

// ------------------------------------------------------------
// Vendor Detector
// ------------------------------------------------------------
function detectVendor(url) {
  if (!url) return null;
  const u = url.toLowerCase();

  const map = {
    municipal: ".gov",
    accela: "accela.com",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech.com",
    mgo: "mygovernmentonline.org",
    opengov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [vendor, key] of Object.entries(map)) {
    if (u.includes(key)) return vendor;
  }
  return "unknown";
}

// ------------------------------------------------------------
// AI Portal Lookup
// ------------------------------------------------------------
async function discoverPortalWithAI(name) {
  const prompt = `
Find the official online building permit portal for "${name}".
Return ONLY JSON:
{ "url": "...", "notes": "..." }
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt
  });

  const text = response.output_text || "";

  try {
    return JSON.parse(text);
  } catch {
    return { url: null, notes: "AI returned non-JSON", raw: text };
  }
}

// ------------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------------
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const geoid = url.searchParams.get("geoid");

    if (!geoid) {
      res.status(400).json({ error: "Missing geoid" });
      return;
    }

    // Get jurisdiction
    const list = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
    if (!list.length) {
      res.status(404).json({ error: "Jurisdiction not found" });
      return;
    }

    const j = list[0];
    const name = `${j.name}, ${j.statefp}`;

    console.log("🔍 Discovering portal for", name);

    // AI lookup
    const ai = await discoverPortalWithAI(name);

    const valid = validateURL(ai.url);
    const vendor = detectVendor(valid);

    // Store into Supabase
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: valid,
      vendor_type: vendor,
      submission_method: valid ? "online" : "unknown",
      license_required: true,
      raw_ai_output: JSON.stringify(ai)
    });

    res.status(200).json({
      geoid,
      name: j.name,
      discovered_url: valid,
      vendor,
      raw_ai_output: ai
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    res.status(500).json({ error: "Internal error", message: err.message });
  }
}
