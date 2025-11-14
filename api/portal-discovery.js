// api/portal-discovery.js
import OpenAI from "openai";

// =============================================
// ENV
// =============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !OPENAI_API_KEY) {
  throw new Error("Missing required environment variables.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// =============================================
// SAFE SUPABASE FETCH (Vercel-native fetch)
// Handles empty bodies + errors correctly
// =============================================
async function sb(path, method = "GET", body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation" // ensures JSON instead of 204
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase Error: ${text}`);
  }

  if (!text || text.trim() === "") return null;

  return JSON.parse(text);
}

// =============================================
// URL VALIDATOR
// =============================================
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const allowed = [
    "accela",
    "energov",
    "etrakit",
    "citizenserve",
    "tylertech",
    "mygovernmentonline",
    "opengov",
    "viewpointcloud",
    "cityview"
  ];

  const lower = url.toLowerCase();

  if (lower.endsWith(".gov")) return url;
  if (allowed.some(v => lower.includes(v))) return url;

  return null;
}

// =============================================
// VENDOR DETECTOR
// =============================================
function detectVendor(url) {
  if (!url) return null;

  const map = {
    accela: "accela",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    mgo: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [vendor, key] of Object.entries(map)) {
    if (url.toLowerCase().includes(key)) return vendor;
  }

  if (url.endsWith(".gov")) return "municipal";
  return "unknown";
}

// =============================================
// AI PORTAL DISCOVERY (Responses API)
// =============================================
async function discoverPortalWithAI(jurisdictionName) {
  const prompt = `
Find the official ONLINE building permit portal for:
"${jurisdictionName}"

Return ONLY a JSON object:
{
  "url": "...",
  "notes": "..."
}

Rules:
- Must be .gov OR a known vendor (Accela, EnerGov, eTrakit, CitizenServe, TylerTech, OpenGov, MGO)
- Ignore PDFs or homepages
- Prefer “permit portal”, “apply for permit”, “contractor login”
`;

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    text: { format: "json" }
  });

  const txt = resp.output_text;
  let parsed = { url: null, notes: "parse_error" };

  try {
    parsed = JSON.parse(txt);
  } catch {
    console.error("❌ JSON parse failure:", txt);
  }

  return parsed;
}

// =============================================
// MAIN HANDLER
// =============================================
export default async function handler(req, res) {
  try {
    const geoid = req.query.geoid;
    const name = req.query.name;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Starting portal discovery for:", geoid, name);

    // 1. Fetch jurisdiction
    const juris = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
    if (!juris || juris.length === 0) {
      return res.status(404).json({ error: "Jurisdiction not found" });
    }

    const readableName = `${juris[0].name}, ${juris[0].statefp}`;

    // 2. AI Lookup
    const ai = await discoverPortalWithAI(readableName);
    const validURL = validateURL(ai.url);
    const vendor = detectVendor(validURL);

    // 3. Upsert portal info
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: validURL,
      vendor_type: vendor,
      submission_method: validURL ? "online" : "unknown",
      license_required: true,
      raw_ai_output: ai.notes || null
    });

    return res.json({
      geoid,
      name,
      discovered_url: validURL,
      vendor,
      raw_ai_output: ai.url
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}
