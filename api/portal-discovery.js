// api/portal-discovery.js
import OpenAI from "openai";
import { request } from "undici";

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
// SAFE SUPABASE FETCH WRAPPER
// (handles 204 No Content correctly)
// =============================================
async function sb(path, method = "GET", body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const res = await request(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation" // always return JSON to avoid 204
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.statusCode || res.statusCode >= 400) {
    const txt = await res.body.text();
    throw new Error(`Supabase Error: ${txt}`);
  }

  const text = await res.body.text();

  // handle empty bodies!
  if (!text || text.trim() === "") return null;

  return JSON.parse(text);
}

// =============================================
// BASIC URL VALIDATOR
// =============================================
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const allowed = [
    "accela", "energov", "etrakit", "citizenserve",
    "tylertech", "mygovernmentonline", "opengov",
    "viewpointcloud", "cityview"
  ];

  const u = url.toLowerCase();
  if (u.endsWith(".gov")) return url;
  if (allowed.some(v => u.includes(v))) return url;

  return null;
}

// =============================================
// DETECT VENDOR TYPE
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
// AI LOOKUP
// Uses the modern OpenAI Responses API
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
- Ignore PDFs or general homepages
- Prefer "permit portal", "contractor login", "apply for permit"
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    text: { format: "json" } // must be object, not string!
  });

  const txt = response.output_text;
  let parsed = { url: null, notes: "parse_error" };

  try {
    parsed = JSON.parse(txt);
  } catch (e) {
    console.error("❌ JSON parse issue:", e, txt);
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

    console.log("🚀 Portal discovery started for:", geoid, name);

    // 1. Fetch jurisdiction
    const juris = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
    if (!juris || juris.length === 0) {
      return res.status(404).json({ error: "Jurisdiction not found" });
    }

    const readableName = `${juris[0].name}, ${juris[0].statefp}`;

    // 2. AI
    const ai = await discoverPortalWithAI(readableName);

    const validURL = validateURL(ai.url);
    const vendor = detectVendor(validURL);

    // 3. Upsert portal record
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
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
