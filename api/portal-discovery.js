// api/portal-discovery.js
export const config = {
  runtime: "nodejs18.x"
};

import OpenAI from "openai";

// ---------- ENV ----------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DAILY_AI_LIMIT = parseInt(process.env.DAILY_AI_LIMIT || "25", 10);
const CRON_SECRET = process.env.CRON_SECRET || null;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ---------- Supabase helper ----------
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
    const errText = await res.text();
    throw new Error(`Supabase Error: ${errText}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- JSON extractor ----------
function extractJsonFromText(text) {
  if (!text) return null;

  let match = text.match(/```json([\s\S]*?)```/i);
  if (!match) match = text.match(/```([\s\S]*?)```/);

  const candidate = match ? match[1] : text;

  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

// ---------- URL validation ----------
function validateURL(url) {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) return null;

  const lower = trimmed.toLowerCase();
  const vendorKeywords = [
    "accela", "energov", "etrakit", "citizenserve", "tylertech",
    "mygovernmentonline", "opengov", "viewpoint", "cityview"
  ];

  if (lower.endsWith(".gov")) return trimmed;
  if (vendorKeywords.some(v => lower.includes(v))) return trimmed;

  return null;
}

// ---------- Vendor detection ----------
function detectVendor(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();

  const map = {
    accela: "accela",
    energov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    mygov: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpoint",
    cityview: "cityview"
  };

  for (const [vendor, keyword] of Object.entries(map)) {
    if (lower.includes(keyword)) return vendor;
  }

  if (lower.endsWith(".gov")) return "municipal";
  return "unknown";
}

// ---------- AI lookup ----------
async function discoverPortalWithAI(readableName) {
  const prompt = `
Return ONLY this shape:

{
  "url": "https://example.gov/permits",
  "notes": "Official building permit portal."
}

Find the official building permit portal for: "${readableName}".
Ignore PDFs, generic homepages, and broken links.
Pick the most direct and official permit portal page.
  `;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt
  });

  let textOutput = "";

  try {
    const first = response.output?.[0];
    const content = first?.content?.[0]?.text;
    textOutput = typeof content === "string" ? content : content?.value || "";
  } catch {
    textOutput = "";
  }

  if (!textOutput && response.output_text) textOutput = response.output_text;

  const parsed = extractJsonFromText(textOutput);

  if (parsed) {
    return {
      url: parsed.url || null,
      notes: parsed.notes || "Parsed JSON",
      raw: textOutput
    };
  }

  return {
    url: null,
    notes: "Non-JSON AI output",
    raw: textOutput
  };
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    // ---------- FIXED AUTH BLOCK ----------
    if (CRON_SECRET) {
      const authHeader =
        req.headers["authorization"] ||
        req.headers["Authorization"] ||
        "";

      if (authHeader !== `Bearer ${CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    console.log("🚀 Portal discovery cron fired");

    // ---------- Daily usage ----------
    const today = new Date().toISOString().slice(0, 10);
    const usageRows = await sb(`portal_ai_usage?day=eq.${today}&limit=1`);
    const used = usageRows?.[0]?.count ?? 0;

    if (used >= DAILY_AI_LIMIT) {
      return res.status(200).json({
        status: "daily_limit_reached",
        used,
        DAILY_AI_LIMIT
      });
    }

    // ---------- Fetch one pending jurisdiction ----------
    const pending = await sb("jurisdictions_without_portals?limit=1");

    if (!pending || pending.length === 0) {
      return res.status(200).json({
        status: "idle",
        message: "No jurisdictions remaining."
      });
    }

    const jur = pending[0];
    const readableName = `${jur.name}, ${jur.statefp}`;
    console.log("🔍 Discovering:", jur.geoid, readableName);

    // ---------- AI discovery ----------
    const ai = await discoverPortalWithAI(readableName);
    const validUrl = validateURL(ai.url);
    const vendor = detectVendor(validUrl);

    // ---------- Insert metadata ----------
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: jur.geoid,
      portal_url: validUrl,
      vendor_type: vendor,
      submission_method: validUrl ? "online" : "unknown",
      license_required: true,
      notes: ai.notes,
      raw_ai_output: ai, // JSONB safe
      updated_at: new Date().toISOString()
    });

    // ---------- Update usage ----------
    if (!usageRows?.length) {
      await sb("portal_ai_usage", "POST", {
        day: today,
        count: 1
      });
    } else {
      await sb(`portal_ai_usage?day=eq.${today}`, "PATCH", {
        count: used + 1
      });
    }

    return res.status(200).json({
      geoid: jur.geoid,
      name: jur.name,
      discovered_url: validUrl,
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
