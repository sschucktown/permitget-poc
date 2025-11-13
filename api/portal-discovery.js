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
   Validation + vendor detection
--------------------------------------------------------- */
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

  const lower = url.toLowerCase();
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
    tyler: "tylertech.com",
    mgo: "mygovernmentonline.org",
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
   AI Portal Discovery (correct 2025 syntax)
--------------------------------------------------------- */
async function discoverPortal(name) {
  const prompt = `
  Find the OFFICIAL building permit portal for: "${name}"

  RULES:
  - Return exactly one URL
  - Must be .gov or:
      Accela, EnerGov, eTrakit, CitizenServe, TylerTech,
      Viewpoint Cloud, OpenGov, MyGovernmentOnline
  - Ignore PDFs, contact pages, general homepages
  - Prefer permit portals / contractor login / permitting systems
  - Return ONLY strict JSON:
    { "url": "...", "notes": "..." }
  `;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    text: { format: "json" }  // ✔ THIS IS CORRECT NOW
  });

  try {
    return JSON.parse(response.output_text);
  } catch (e) {
    return { url: null, notes: "JSON parse failed" };
  }
}

/* ---------------------------------------------------------
   Main handler
--------------------------------------------------------- */
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;
    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    console.log("🚀 Portal discovery for:", geoid, name);

    const ai = await discoverPortal(name);
    const validated = validateURL(ai.url);
    const vendor = detectVendor(validated);

    if (validated) {
      await sb("jurisdiction_meta", "POST", {
        jurisdiction_geoid: geoid,
        portal_url: validated,
        vendor_type: vendor,
        submission_method: "online",
        license_required: true,
        notes: ai?.notes || ""
      });
    }

    return res.json({
      geoid,
      jurisdiction: name,
      discovered_url: validated,
      vendor,
      raw: ai
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
