// api/portal-discovery.js
import OpenAI from "openai";
import { URL } from "url";

// -----------------------------
// ENV VARS
// -----------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// -----------------------------
// Supabase wrapper
// -----------------------------
async function sb(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const errMsg = await res.text().catch(() => "Unknown Supabase error");
    throw new Error(`Supabase Error: ${errMsg}`);
  }

  return res.json();
}

// -----------------------------
// Validate URL
// -----------------------------
function validateURL(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    const vendors = [
      "accela",
      "energov",
      "etrakit",
      "citizenserve",
      "tylertech",
      "mygovernmentonline",
      "opengov",
      "viewpoint",
      "cityview"
    ];

    if (host.endsWith(".gov")) return u;
    if (vendors.some((v) => host.includes(v))) return u;

    return null;
  } catch {
    return null;
  }
}

// -----------------------------
// Detect vendor keyword
// -----------------------------
function detectVendor(url) {
  if (!url) return null;
  const u = url.toLowerCase();

  if (u.includes("accela")) return "accela";
  if (u.includes("energov")) return "energov";
  if (u.includes("etrakit")) return "etrakit";
  if (u.includes("citizenserve")) return "citizenserve";
  if (u.includes("tyler")) return "tyler";
  if (u.includes("mygovernmentonline")) return "mgo";
  if (u.includes("viewpoint")) return "viewpoint";
  if (u.includes("cityview")) return "cityview";
  if (u.includes("opengov")) return "opengov";
  if (u.endsWith(".gov")) return "municipal";
  return "unknown";
}

// -----------------------------
// OpenAI — Responses API
// -----------------------------
async function discoverPortalWithAI(jurisdictionName) {
  const prompt = `
Find the OFFICIAL online building permit portal for:
"${jurisdictionName}"

RULES:
- Return ONLY JSON.
- Must be .gov OR a known vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO).
- Ignore PDFs.
- Ignore homepages unless they link directly to permits.
- Prioritize "building permits", "permit portal", "contractor login".

JSON Response:
{
  "url": "https://...",
  "notes": "why this is correct"
}
`;

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    input: prompt
  });

  const rawText =
    resp.output?.[0]?.content?.[0]?.text?.trim() ?? "";

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
// Vercel endpoint handler
// -----------------------------
export default async function handler(req, res) {
  try {
    const { geoid, name } = req.query;

    if (!geoid || !name) {
      return res.status(400).json({ error: "Missing geoid or name" });
    }

    // 1. Get AI result
    const ai = await discoverPortalWithAI(name);

    // 2. Validate the URL
    const portal = validateURL(ai.url);
    const vendor = detectVendor(portal);

    // 3. Write to Supabase
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: portal,
      vendor_type: vendor,
      submission_method: portal ? "online" : null,
      license_required: portal ? true : null,
      notes: ai.notes,
      raw_ai_output: ai.raw_ai_output
    });

    return res.status(200).json({
      geoid,
      name,
      discovered_url: portal,
      vendor,
      raw_ai_output: ai.raw_ai_output
    });
  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}
