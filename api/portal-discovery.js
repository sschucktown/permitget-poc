// api/portal-discovery.js
import OpenAI from "openai";
import { URL } from "url";

// -----------------------------
// ENV VARS (REQUIRED)
// -----------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // MUST be service_role
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// -----------------------------
// Supabase wrapper
// -----------------------------
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
    let msg;
    try {
      msg = await res.text();
    } catch {
      msg = "unknown sb error";
    }
    throw new Error(`Supabase Error: ${msg}`);
  }
  return res.json();
}

// -----------------------------
// Validate portal URL
// -----------------------------
function validateURL(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    const vendors = [
      "accela", "energov", "etrakit",
      "citizenserve", "tylertech",
      "mygovernmentonline", "opengov", "viewpoint", "cityview"
    ];

    if (host.endsWith(".gov")) return u;
    if (vendors.some(v => host.includes(v))) return u;

    return null;
  } catch {
    return null;
  }
}

// -----------------------------
// Detect vendor from URL
// -----------------------------
function detectVendor(u) {
  if (!u) return null;
  const host = u.toLowerCase();

  if (host.includes("accela")) return "accela";
  if (host.includes("energov")) return "energov";
  if (host.includes("etrakit")) return "etrakit";
  if (host.includes("citizenserve")) return "citizenserve";
  if (host.includes("tyler")) return "tyler";
  if (host.includes("mygovernmentonline")) return "mgo";
  if (host.includes("opengov")) return "opengov";
  if (host.includes("viewpoint")) return "viewpoint";
  if (host.includes("cityview")) return "cityview";
  if (host.endsWith(".gov")) return "municipal";
  return "unknown";
}

// -----------------------------
// OpenAI lookup (Responses API)
// -----------------------------
async function discoverPortalWithAI(jurisdictionName) {
  const prompt = `
Find the OFFICIAL online building permit portal for:
"${jurisdictionName}"

RULES:
- Return ONLY valid JSON.
- Must be a .gov site OR a known vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO).
- Ignore PDFs.
- Ignore city/county homepages unless they link directly to permits.
- Prefer "permit portal", "contractor login", or "building permits" pages.

JSON shape:
{
  "url": "https://...",
  "notes": "why this URL"
}
  `;

  // ⬇️ Responses API — MUST use `input`
  const response = await client.responses.create({
    model: "gpt-4o-mini",
    reasoning: { effort: "low" },
    input: prompt
  });

  // ⬇️ Correct extraction
  const rawText = response.output?.[0]?.content?.[0]?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      url: null,
      notes: "AI returned non-JSON output",
      raw_ai_output: rawText
    };
  }

  return {
    url: parsed.url || null,
    notes: parsed.notes || "",
    raw_ai_output: rawText
  };
}

// -----------------------------
// Handler (supports GET single lookup)
// -----------------------------
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    // 1. Call AI discovery
    const result = await discoverPortalWithAI(name);

    // 2. Validate URL
    const valid = validateURL(result.url);
    const vendor = detectVendor(valid);

    // 3. Upsert into jurisdiction_meta
    const payload = {
      jurisdiction_geoid: geoid,
      portal_url: valid,
      vendor_type: vendor,
      submission_method: valid ? "online" : null,
      license_required: valid ? true : null,
      notes: result.notes || "",
      raw_ai_output: result.raw_ai_output || ""
    };

    await sb("jurisdiction_meta", "POST", payload);

    // 4. Return result
    return res.status(200).json({
      geoid,
      name,
      discovered_url: valid,
      vendor,
      raw_ai_output: result.raw_ai_output
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}
