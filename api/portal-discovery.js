// api/portal-discovery.js
// Vercel Serverless Function – Portal Discovery Worker (OpenAI Responses API 2025)

import OpenAI from "openai";

// --- ENV ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// --- CLIENT ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ============================================================
   SUPABASE HELPER
============================================================ */
async function sb(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }

  return res.json();
}

/* ============================================================
   URL VALIDATION + VENDOR DETECTION
============================================================ */
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const allowed = [
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

  const lower = url.toLowerCase();

  if (lower.endsWith(".gov")) return url;
  if (allowed.some(v => lower.includes(v))) return url;

  return null;
}

function detectVendor(url) {
  if (!url) return null;

  const map = {
    accela: "accela.com",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech.com",
    myGOV: "mygovernmentonline.org",
    openGov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  const lower = url.toLowerCase();

  for (const [vendor, keyword] of Object.entries(map)) {
    if (lower.includes(keyword)) return vendor;
  }

  if (lower.endsWith(".gov")) return "municipal";

  return "unknown";
}

/* ============================================================
   AI PORTAL DISCOVERY (Responses API)
============================================================ */
async function discoverPortal(jurisdictionName) {
  const prompt = `
  Find the OFFICIAL building permit portal for: "${jurisdictionName}"

  RULES:
  - Return EXACTLY one portal URL
  - Must be .gov or a known vendor:
      Accela, EnerGov, eTrakit, CitizenServe, TylerTech,
      Viewpoint Cloud, OpenGov, MyGovernmentOnline
  - Ignore PDFs, homepages, contact pages
  - Prefer "permit portal", "contractor login", "permitting system"
  - Return ONLY proper JSON:
    {
      "url": "...",
      "notes": "..."
    }
  `;

  const result = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    text: { format: "json" }  // NEW 2025 format
  });

  try {
    const json = JSON.parse(result.output_text);
    return json;
  } catch (err) {
    return { url: null, notes: "JSON parse failed" };
  }
}

/* ============================================================
   MAIN HANDLER (Runs on each call or cron ping)
============================================================ */
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Portal discovery started for:", geoid, name);

    /* 1. Call AI to discover portal */
    const result = await discoverPortal(name);
    const rawUrl = result?.url || null;

    /* 2. Validate + detect vendor */
    const validURL = validateURL(rawUrl);
    const vendor = detectVendor(validURL);

    /* 3. Upsert into jurisdiction_meta */
    if (validURL) {
      await sb("jurisdiction_meta", "POST", {
        jurisdiction_geoid: geoid,
        portal_url: validURL,
        vendor_type: vendor,
        submission_method: "online",
        license_required: true,
        notes: result?.notes || ""
      });
    }

    console.log("✅ Discovery complete:", { geoid, validURL });

    return res.json({
      geoid,
      name,
      discovered_url: validURL,
      vendor,
      raw: result
    });

  } catch (error) {
    console.error("🔥 Worker Error:", error);
    return res.status(500).json({
      error: "Internal error",
      message: error.message
    });
  }
}
