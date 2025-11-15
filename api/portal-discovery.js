// api/portal-discovery.js
export const config = {
  runtime: "nodejs"
};

import OpenAI from "openai";

// ---------- ENV ----------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DAILY_AI_LIMIT = parseInt(process.env.DAILY_AI_LIMIT || "25", 10);
const CRON_SECRET = process.env.CRON_SECRET || null;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ---------- Time (Eastern Date) ----------
function getEasternDateString() {
  const est = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
  });
  const [month, day, year] = est.split(",")[0].split("/");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
const today = getEasternDateString();

// ---------- Supabase ----------
async function sb(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`Supabase Error: ${await res.text()}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- JSON Extractor ----------
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

// ---------- URL Validation ----------
function validateURL(url) {
  if (!url) return null;
  const t = url.trim().toLowerCase();
  if (!t.startsWith("http")) return null;
  if (t.endsWith(".gov")) return url;

  const vendors = [
    "accela",
    "energov",
    "etrakit",
    "citizenserve",
    "tylertech",
    "mygovernmentonline",
    "opengov",
    "viewpoint",
    "cityview",
  ];

  if (vendors.some((v) => t.includes(v))) return url;

  return null;
}

// ---------- Vendor Detection ----------
function detectVendor(url) {
  if (!url) return "unknown";
  const t = url.toLowerCase();

  const map = {
    accela: "accela",
    energov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    mygov: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpoint",
    cityview: "cityview",
  };

  for (const [vendor, key] of Object.entries(map)) {
    if (t.includes(key)) return vendor;
  }

  return t.endsWith(".gov") ? "municipal" : "unknown";
}

// ---------- AI lookup ----------
async function discoverPortalWithAI(name) {
  const prompt = `
Return ONLY JSON:

{
  "url": "https://example.gov/permits",
  "notes": "Official building permit portal."
}

Find the official online building permit portal for: "${name}".
Ignore PDFs, generic homepages, and non-portals.
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let textOut = "";

  try {
    const first = response.output?.[0];
    const content = first?.content?.[0]?.text;
    textOut = typeof content === "string" ? content : content?.value || "";
  } catch {
    textOut = "";
  }

  if (!textOut && response.output_text) textOut = response.output_text;

  const parsed = extractJsonFromText(textOut);

  if (parsed) {
    return {
      url: parsed.url || null,
      notes: parsed.notes || "Parsed JSON",
      raw: textOut,
    };
  }

  return {
    url: null,
    notes: "AI returned non-JSON",
    raw: textOut,
  };
}

// -------------------------------------------------------------
// MAIN HANDLER
// -------------------------------------------------------------
export default async function handler(req, res) {
  try {
    // AUTH
    if (CRON_SECRET) {
      const h =
        req.headers["authorization"] ||
        req.headers["Authorization"] ||
        "";

      if (h !== `Bearer ${CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    console.log("🚀 Portal discovery fired");

    // Check AI usage
    const usage = await sb(`portal_ai_usage?day=eq.${today}`);
    const used = usage?.[0]?.count || 0;

    if (used >= DAILY_AI_LIMIT) {
      return res.status(200).json({
        status: "daily_limit_reached",
        used,
        DAILY_AI_LIMIT,
      });
    }

    // Get next jurisdiction
    const pending = await sb("jurisdictions_without_portals?limit=1");

    if (!pending?.length) {
      return res.status(200).json({
        status: "idle",
        message: "No jurisdictions remaining",
      });
    }

    const j = pending[0];
    const readable = `${j.name}, ${j.statefp}`;
    console.log("🔍 Discovering:", j.geoid, readable);

    // AI
    const ai = await discoverPortalWithAI(readable);
    const url = validateURL(ai.url);
    const vendor = detectVendor(url);

    // Write metadata
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: j.geoid,
      portal_url: url,
      vendor_type: vendor,
      submission_method: url ? "online" : "unknown",
      license_required: true,
      notes: ai.notes,
      raw_ai_output: ai,
      updated_at: new Date().toISOString(),
    });

    // Update usage
    if (!usage?.length) {
      await sb("portal_ai_usage", "POST", {
        day: today,
        count: 1,
      });
    } else {
      await sb(`portal_ai_usage?day=eq.${today}`, "PATCH", {
        count: used + 1,
      });
    }

    return res.status(200).json({
      geoid: j.geoid,
      name: j.name,
      discovered_url: url,
      vendor,
      raw_ai_output: ai,
    });
  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
