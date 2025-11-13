// api/portal-discovery.js
import OpenAI from "openai";

// =============================
// CONFIG
// =============================
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // MUST be service role key

// Allowed vendors for classification
const ALLOWED_VENDORS = [
  "accela",
  "energov",
  "etrakit",
  "citizenserve",
  "tylertech",
  "mygovernmentonline",
  "opengov",
  "viewpoint",
  "cityview"
];

// =============================
// Supabase fetch helper
// =============================
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
    const msg = await res.text();
    throw new Error(`Supabase error: ${msg}`);
  }

  return res.json();
}

// =============================
// URL validator
// =============================
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const lowered = url.toLowerCase();

  if (lowered.endsWith(".gov")) return url;

  for (const vendor of ALLOWED_VENDORS) {
    if (lowered.includes(vendor)) return url;
  }

  return null;
}

// =============================
// Vendor detector
// =============================
function detectVendor(url) {
  if (!url) return null;
  const lc = url.toLowerCase();

  if (lc.endsWith(".gov")) return "municipal";

  for (const vendor of ALLOWED_VENDORS) {
    if (lc.includes(vendor)) return vendor;
  }

  return "unknown";
}

// =============================
// OpenAI — Portal Discovery
// =============================
async function discoverPortalWithAI(jurisdictionName) {
  const prompt = `
Find the OFFICIAL online building permit portal for:
"${jurisdictionName}"

RULES:
- Return ONLY valid JSON.
- Must be a .gov site OR a known vendor portal (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO).
- Ignore PDFs.
- Ignore city/county homepages unless they have direct permit links.
- Prefer "permit portal", "contractor login", or "building permits".
- JSON shape:

{
  "url": "https://...",
  "notes": "why this URL"
}
`;

  // 🔥 NEW RESPONSES API — correct usage
  const response = await client.responses.create({
    model: "gpt-4o-mini",
    reasoning: { effort: "low" },
    text: prompt // <-- CORRECT: no format field
  });

  const rawText = response.output_text; // <-- SAFE: returns the text directly

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      url: null,
      notes: "Failed to parse JSON",
      raw_ai_output: rawText
    };
  }

  return { ...parsed, raw_ai_output: rawText };
}

// =============================
// MAIN HANDLER
// =============================
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🔍 Starting discovery for:", geoid, name);

    // 1. AI lookup
    const aiResult = await discoverPortalWithAI(name);

    const validURL = validateURL(aiResult.url);
    const vendor = detectVendor(validURL);

    // 2. Save to Supabase (jurisdiction_meta upsert)
    if (validURL) {
      await sb("jurisdiction_meta", "POST", {
        jurisdiction_geoid: geoid,
        portal_url: validURL,
        vendor_type: vendor,
        submission_method: "online",
        license_required: true,
        notes: aiResult.notes || ""
      });
    }

    // 3. Return result
    return res.status(200).json({
      geoid,
      name,
      discovered_url: validURL,
      vendor,
      raw_ai_output: aiResult.raw_ai_output
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
