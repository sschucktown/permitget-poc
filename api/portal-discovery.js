// api/portal-discovery.js
import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------------------------------------------------
   Supabase helper
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

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ---------------------------------------------------------
   URL Extractor / Validator
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

  if (lower.endsWith(".gov")) return url;
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

  if (lower.endsWith(".gov")) return "municipal";
  return "unknown";
}

/* ---------------------------------------------------------
   SIMPLEST POSSIBLE AI CALL (your SDK requires this)
--------------------------------------------------------- */
async function discoverPortal(jurisdictionName) {
  const prompt = `
Find the official building permit portal for: "${jurisdictionName}"

RULES:
- Return ONLY the official permit portal URL.
- Must be .gov or a known vendor (Accela, EnerGov, eTrakit, CitizenServe, OpenGov, TylerTech, MGO).
- No PDFs, no homepages, no internal pages.
- Put the URL on the FIRST line only.
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt
  });

  // Your SDK stores output here:
  const text = response.output_text || 
               response.output?.[0]?.content?.[0]?.text || 
               "";

  return text.trim();
}

/* ---------------------------------------------------------
   API Route
--------------------------------------------------------- */
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;
    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Running portal discovery for:", geoid, name);

    // 1. AI Call
    const raw = await discoverPortal(name);

    // 2. Extract URL
    const foundURL = extractURL(raw);
    const valid = validateURL(foundURL);
    const vendor = detectVendor(valid);

    // 3. Save if valid
    if (valid) {
      await sb("jurisdiction_meta", "POST", {
        jurisdiction_geoid: geoid,
        portal_url: valid,
        vendor_type: vendor,
        submission_method: "online",
        license_required: true,
        notes: raw
      });
    }

    return res.json({
      geoid,
      name,
      discovered_url: valid,
      vendor,
      raw_ai_output: raw
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
