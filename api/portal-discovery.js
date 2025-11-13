// api/portal-discovery.js
// Vercel Function – Portal Discovery Worker

import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

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

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ============================================================
   VALIDATION + VENDOR DETECTION
============================================================ */
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const vendorDomains = [
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
  if (vendorDomains.some(v => lower.includes(v))) return url;
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
   AI PORTAL DISCOVERY (Responses API — correct format)
============================================================ */
async function discoverPortal(jurisdictionName) {
  const prompt = `
  Find the OFFICIAL building permit portal for: "${jurisdictionName}"

  RULES:
  - Return exactly ONE URL
  - Must be .gov or known vendor:
      Accela, EnerGov, eTrakit, CitizenServe, TylerTech,
      Viewpoint Cloud, OpenGov, MyGovernmentOnline
  - Ignore PDFs, homepages, contact pages
  - Prefer "permit portal", "contractor login", "permitting system"
  - Return ONLY valid JSON:
    {
      "url": "...",
      "notes": "..."
    }
  `;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    response_format: { type: "json" }    // ✔ CORRECT 2025 FORMAT
  });

  try {
    return JSON.parse(response.output_text);
  } catch {
    return { url: null, notes: "JSON parse failed" };
  }
}

/* ============================================================
   HANDLER
============================================================ */
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Portal discovery for:", geoid, name);

    // 1. AI lookup
    const result = await discoverPortal(name);
    const rawUrl = result?.url || null;

    // 2. Validate + classify
    const validURL = validateURL(rawUrl);
    const vendor = detectVendor(validURL);

    // 3. Store in Supabase if good
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

    return res.json({
      geoid,
      name,
      discovered_url: validURL,
      vendor,
      raw: result
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}
