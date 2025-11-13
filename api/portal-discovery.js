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
   Vendor detection + URL validation
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
   AI Portal Discovery — plain text only
--------------------------------------------------------- */
async function discoverPortal(name) {
  const prompt = `
  Find the official building permit portal for: "${name}"

  RULES:
  - Return EXACTLY ONE URL
  - It must be the direct permitting system portal
  - Allowed vendors: Accela, EnerGov, eTrakit, CitizenServe, TylerTech, Viewpoint, OpenGov, MyGovernmentOnline
  - OR any .gov permitting portal
  - No PDFs, no homepages, no broken links
  - Respond with ONLY the URL on the first line
  `;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    text: true
  });

  return response.output_text;
}

/* ---------------------------------------------------------
   API route
--------------------------------------------------------- */
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;
    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Portal discovery for:", geoid, name);

    // 1. AI guess
    const raw = await discoverPortal(name);

    // 2. Extract URL from plain text
    const foundURL = extractURL(raw);
    const valid = validateURL(foundURL);
    const vendor = detectVendor(valid);

    // 3. If valid, save to Supabase
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
      jurisdiction: name,
      discovered_url: valid,
      vendor,
      raw_ai_output: raw
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
