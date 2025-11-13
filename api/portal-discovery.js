// api/portal-discovery.js
import OpenAI from "openai";
import fetch from "node-fetch";

/* -----------------------------
   ENVIRONMENT
------------------------------ */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* -----------------------------
   LIGHTWEIGHT SUPABASE CLIENT
------------------------------ */
async function sb(path, { method = "GET", body = null, query = "" } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}${query ? "?" + query : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Supabase error: ${errorText}`);
  }

  return res.json();
}

/* -----------------------------
   URL VALIDATION
------------------------------ */
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const allowedVendors = [
    "accela",
    "energov",
    "etrakit",
    "citizenserve",
    "tylertech",
    "mygovernmentonline",
    "opengov",
    "viewpointcloud",
    "cityview",
  ];

  const lower = url.toLowerCase();

  if (lower.endsWith(".gov")) return url;
  if (allowedVendors.some((v) => lower.includes(v))) return url;

  return null;
}

/* -----------------------------
   DETECT VENDOR
------------------------------ */
function detectVendor(url) {
  if (!url) return null;

  const map = {
    accela: "accela",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    myGOV: "mygovernmentonline",
    openGov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview",
  };

  const lower = url.toLowerCase();

  for (const [vendor, keyword] of Object.entries(map)) {
    if (lower.includes(keyword)) return vendor;
  }

  if (lower.endsWith(".gov")) return "municipal";

  return "unknown";
}

/* -----------------------------
   AI PORTAL DISCOVERY
   (Using OpenAI Responses API)
------------------------------ */
async function discoverPortalWithAI(jurisdictionName) {
  const prompt = `
Return ONLY a JSON object.
Find the *official* building permit portal for:

"${jurisdictionName}"

RULES:
- Must be a .gov site OR a known vendor portal (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO, ViewpointCloud, CityView)
- Prefer: "permit portal", "contractor login", "building permits"
- Ignore PDFs, forms, and general city homepages
- Output format:
{
  "url": "...",
  "notes": "..."
}`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    text: { format: "json" },
  });

  return response.output[0].parsed; // Clean JSON output
}

/* -----------------------------
   UPSERT META ROW
------------------------------ */
async function upsertMeta(geoid, data) {
  return sb("jurisdiction_meta", {
    method: "POST",
    body: {
      jurisdiction_geoid: geoid,
      ...data,
    },
  });
}

/* -----------------------------
   BATCH PROCESSING
------------------------------ */
async function runBatch(limit = 50) {
  // 1. Get next unknown jurisdictions
  const rows = await sb("jurisdictions_needing_portal", {
    query: `limit=${limit}`,
  });

  if (!rows.length) {
    return { processed: 0, message: "No jurisdictions left needing portals." };
  }

  let successes = [];
  let failures = [];

  // 2. Loop through each jurisdiction
  for (const jur of rows) {
    try {
      const readable = `${jur.name}, ${jur.statefp}`;

      const ai = await discoverPortalWithAI(readable);
      const validated = validateURL(ai.url);
      const vendor = detectVendor(validated);

      await upsertMeta(jur.geoid, {
        portal_url: validated,
        vendor_type: vendor,
        submission_method: validated ? "online" : "unknown",
        license_required: true,
        notes: ai.notes || "",
      });

      successes.push({
        geoid: jur.geoid,
        name: jur.name,
        url: validated,
      });
    } catch (err) {
      failures.push({
        geoid: jur.geoid,
        name: jur.name,
        error: err.message,
      });
    }
  }

  return {
    processed: rows.length,
    successes,
    failures,
  };
}

/* -----------------------------
   SINGLE LOOKUP
------------------------------ */
async function handleSingle(geoid, name) {
  const readable = `${name}`;

  const ai = await discoverPortalWithAI(readable);
  const validated = validateURL(ai.url);
  const vendor = detectVendor(validated);

  await upsertMeta(geoid, {
    portal_url: validated,
    vendor_type: vendor,
    submission_method: validated ? "online" : "unknown",
    license_required: true,
    notes: ai.notes || "",
  });

  return {
    geoid,
    name,
    discovered_url: validated,
    vendor,
    raw_ai_output: ai.url,
  };
}

/* -----------------------------
   MAIN HANDLER
------------------------------ */
export default async function handler(req, res) {
  try {
    const mode = req.query.mode || "single";

    if (mode === "batch") {
      const limit = Number(req.query.limit || 50);
      const result = await runBatch(limit);
      res.status(200).json(result);
      return;
    }

    // Single mode
    const geoid = req.query.geoid;
    const name = req.query.name;

    if (!geoid || !name) {
      res.status(400).json({ error: "Missing geoid or name" });
      return;
    }

    const result = await handleSingle(geoid, name);
    res.status(200).json(result);
  } catch (err) {
    console.error("🔥 Worker Error:", err);
    res.status(500).json({ error: "Internal error", message: err.message });
  }
}
