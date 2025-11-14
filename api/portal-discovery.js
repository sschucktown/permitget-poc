// api/portal-discovery.js
import OpenAI from "openai";

// ------------------------------------------------------------
// ENVIRONMENT
// ------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// ------------------------------------------------------------
// BASIC SUPABASE REST CLIENT
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
    const err = await res.text().catch(() => "");
    throw new Error(`Supabase Error: ${err}`);
  }

  return res.json();
}

// ------------------------------------------------------------
// URL CLEANER / VALIDATOR
// ------------------------------------------------------------
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
    "cityview",
  ];

  const lower = url.toLowerCase();

  if (lower.endsWith(".gov")) return url;
  if (allowed.some(a => lower.includes(a))) return url;

  return null;
}

// ------------------------------------------------------------
// VENDOR DETECTOR
// ------------------------------------------------------------
function detectVendor(url) {
  if (!url) return null;
  const s = url.toLowerCase();

  const map = {
    accela: "accela.com",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech.com",
    myGOV: "mygovernmentonline.org",
    opengov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [vendor, match] of Object.entries(map)) {
    if (s.includes(match)) return vendor;
  }

  if (s.endsWith(".gov")) return "municipal";

  return "unknown";
}

// ------------------------------------------------------------
// AI PORTAL DISCOVERY (SAFE, CLEAN, NO UNSUPPORTED PARAMS)
// ------------------------------------------------------------
async function discoverPortalWithAI(jurisdictionName) {
  const prompt = `
Find the official ONLINE building permit portal for:
"${jurisdictionName}"

Return ONLY a JSON object like:
{
  "url": "...",
  "notes": "..."
}

Rules:
- Must be .gov OR a known vendor (Accela, EnerGov, eTrakit, CitizenServe, TylerTech, OpenGov, MGO)
- Ignore PDFs or front page homepages
- Prefer pages like “apply for permit”, “permit portal”, “contractor login”
`;

  const completion = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt
  });

  const text = completion.output_text || "";

  // Try parsing JSON
  try {
    return JSON.parse(text);
  } catch (e) {
    return {
      url: null,
      notes: "AI did not return valid JSON",
      raw: text
    };
  }
}

// ------------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------------
export async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    const geoid = searchParams.get("geoid");

    if (!geoid) {
      return new Response(JSON.stringify({ error: "Missing geoid" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 1. Load jurisdiction
    const rows = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
    if (!rows.length) {
      return new Response(JSON.stringify({ error: "Jurisdiction not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const jurisdiction = rows[0];
    const name = jurisdiction.name;
    const statefp = jurisdiction.statefp;
    const displayName = `${name}, ${statefp}`;

    console.log("🔍 Running portal discovery for:", displayName);

    // 2. Run AI
    const ai = await discoverPortalWithAI(displayName);

    const valid = validateURL(ai.url);
    const vendor = detectVendor(valid);

    // 3. Store results in DB
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: valid,
      vendor_type: vendor,
      submission_method: valid ? "online" : "unknown",
      license_required: true,
      raw_ai_output: JSON.stringify(ai)
    });

    // 4. Return to client
    return new Response(
      JSON.stringify({
        geoid,
        name,
        discovered_url: valid,
        vendor,
        raw_ai_output: ai
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return new Response(
      JSON.stringify({
        error: "Internal error",
        message: err.message
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export const config = {
  runtime: "edge"
};
