// api/portal-discovery.js
import OpenAI from "openai";

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------------------------------------------------
   SUPABASE WRAPPER — bulletproof against 204/empty bodies
--------------------------------------------------------- */
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

  const text = await res.text();
  if (!text) return null;          // Avoid "Unexpected end of JSON input"

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ---------------------------------------------------------
   URL EXTRACTION UTILITIES
--------------------------------------------------------- */
function extractURL(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s"']+/i);
  return match ? match[0] : null;
}

function validateURL(url) {
  if (!url) return null;

  const lower = url.toLowerCase();

  const vendors = [
    "accela.com",
    "energov",
    "etrakit",
    "citizenserve.com",
    "tylertech",
    "mygovernmentonline",
    "opengov",
    "viewpointcloud",
    "cityview"
  ];

  // Accept ANY .gov URL including `.gov/...`
  if (lower.includes(".gov")) return url;

  // Accept vendor systems
  if (vendors.some(v => lower.includes(v))) return url;

  return null;
}

function detectVendor(url) {
  if (!url) return null;
  const lower = url.toLowerCase();

  const map = {
    accela: "accela.com",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech",
    mgo: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [vendor, key] of Object.entries(map)) {
    if (lower.includes(key)) return vendor;
  }

  if (lower.includes(".gov")) return "municipal";
  return "unknown";
}

/* ---------------------------------------------------------
   OPENAI DEEP RESEARCH — correct Responses API syntax
--------------------------------------------------------- */
async function discoverPortal(jurisdictionName) {
  const prompt = `
Find the official building permit portal for: "${jurisdictionName}"

RULES:
- Return ONLY the official permit portal URL.
- Must be .gov or a known vendor (Accela, EnerGov, eTrakit, CitizenServe, TylerTech, MGO, OpenGov).
- No PDFs, no homepages, no random links.
- Put the URL on the **first line only**.
`;

  // Correct Responses API usage — NO response_format, NO text.format
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt
  });

  // Compatible with ALL SDK variations:
  const output =
    response.output_text ||
    response.output?.[0]?.content?.[0]?.text ||
    "";

  return output.trim();
}

/* ---------------------------------------------------------
   API ROUTE (Vercel)
--------------------------------------------------------- */
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Portal discovery started for:", geoid, name);

    // 1. Call OpenAI
    const raw = await discoverPortal(name);

    // 2. Extract and validate URL
    const extracted = extractURL(raw);
    const validURL = validateURL(extracted);
    const vendor = detectVendor(validURL);

    // 3. Save to Supabase only if valid
    if (validURL) {
      await sb("jurisdiction_meta", "POST", {
        jurisdiction_geoid: geoid,
        portal_url: validURL,
        vendor_type: vendor,
        submission_method: "online",
        license_required: true,
        notes: raw
      });
    }

    return res.status(200).json({
      geoid,
      name,
      discovered_url: validURL,
      vendor,
      raw_ai_output: raw
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message || "Unknown error"
    });
  }
}
