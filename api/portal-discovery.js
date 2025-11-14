// api/portal-discovery.js
// Vercel Node runtime (NOT Edge)
export const config = {
  runtime: "nodejs",
};

import OpenAI from "openai";

// -------- CONFIG --------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;


// -------- Supabase Helper --------
async function sb(path, method = "GET", body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase Error: ${text}`);
  }

  // handle empty-body responses gracefully
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}


// -------- AI Helper: Remove Code Fences --------
function cleanAI(text) {
  if (!text) return text;
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}


// -------- Vendor Detection --------
function detectVendor(url) {
  if (!url) return null;

  const u = url.toLowerCase();
  const map = {
    accela: "accela",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    opengov: "opengov",
    mgo: "mygovernmentonline",
    cityview: "cityview",
    viewpoint: "viewpoint"
  };

  for (const [vendor, keyword] of Object.entries(map)) {
    if (u.includes(keyword)) return vendor;
  }

  if (u.endsWith(".gov")) return "municipal";
  return "unknown";
}


// -------- Validate URL --------
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  return url;
}


// -------- AI Portal Research --------
async function discoverPortalWithAI(name, statefp) {
  const prompt = `
Find the OFFICIAL online building permit portal for:
"${name}, ${statefp}"

Return ONLY valid JSON:
{
  "url": "https://....",
  "notes": "..."
}

Rules:
- Must be a .gov domain OR major vendor system (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO, CityView, Viewpoint)
- Ignore PDFs
- Ignore city homepages unless they directly link to permitting
- If unsure, return { "url": null, "notes": "Not found" }
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt
  });

  const raw = response.output_text;
  const cleaned = cleanAI(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      url: null,
      notes: "AI returned non-JSON",
      raw
    };
  }
}


// -------- Insert Meta --------
async function saveMeta(geoid, url, vendor, notes) {
  return await sb("jurisdiction_meta", "POST", {
    jurisdiction_geoid: geoid,
    portal_url: url,
    vendor_type: vendor,
    submission_method: url ? "online" : "unknown",
    license_required: true,
    notes
  });
}


// -------- Main Handler --------
export default async function handler(req, res) {
  try {
    const geoid = req.query.geoid;
    if (!geoid) {
      return res.status(400).json({ error: "Missing geoid" });
    }

    console.log("🚀 Starting portal discovery for", geoid);

    // 1. Fetch jurisdiction
    const jur = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
    if (!jur.length) {
      return res.status(404).json({ error: "Jurisdiction not found" });
    }

    const j = jur[0];
    const readableName = `${j.name}`;
    const statefp = j.statefp || "";

    // 2. Run AI
    const ai = await discoverPortalWithAI(readableName, statefp);

    // 3. Validate
    const validURL = validateURL(ai.url);
    const vendor = detectVendor(validURL);

    // 4. Save to DB
    await saveMeta(geoid, validURL, vendor, ai.notes || "No notes");

    // 5. Return result
    return res.status(200).json({
      geoid,
      name: readableName,
      discovered_url: validURL,
      vendor,
      raw_ai_output: ai
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}
