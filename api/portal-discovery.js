// api/portal-discovery.js
export const config = {
  runtime: "nodejs18.x"
};

import OpenAI from "openai";

// ---------- ENV ----------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DAILY_AI_LIMIT = parseInt(process.env.DAILY_AI_LIMIT || "25", 10); // safety cap
const CRON_SECRET = process.env.CRON_SECRET || null;

if (!OPENAI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn("⚠️ Missing required environment variables for portal discovery.");
}

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

  // Some writes may return empty body; guard parse.
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- URL utilities ----------
function validateURL(url) {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http")) return null;
  if (!trimmed.includes(".")) return null;

  const lower = trimmed.toLowerCase();

  const vendorKeywords = [
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

  if (lower.endsWith(".gov")) return trimmed;
  if (vendorKeywords.some(v => lower.includes(v))) return trimmed;

  return null;
}

function detectVendor(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();

  const map = {
    accela: "accela",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    myGOV: "mygovernmentonline",
    openGov: "opengov",
    viewpoint: "viewpoint",
    cityview: "cityview"
  };

  for (const [vendor, keyword] of Object.entries(map)) {
    if (lower.includes(keyword)) return vendor;
  }

  if (lower.endsWith(".gov")) return "municipal";
  return "unknown";
}

// ---------- JSON extractor from model text ----------
function extractJsonFromText(text) {
  if (!text) return null;

  // Try ```json ... ``` block first
  let match = text.match(/```json([\s\S]*?)```/i);
  if (!match) {
    // Try generic ``` ... ```
    match = text.match(/```([\s\S]*?)```/);
  }

  const candidate = match ? match[1] : text;

  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

// ---------- AI call ----------
async function discoverPortalWithAI(readableName) {
  const prompt = `
You are a building permit portal locator.

Return ONLY a JSON object, nothing else, like:
{
  "url": "https://example.gov/permits",
  "notes": "Short explanation of why this is the official portal."
}

Rules:
- It MUST be the official online building permit portal for: "${readableName}".
- Prefer pages that say things like "online permits", "contractor login", "permit portal", or "apply for building permits".
- Ignore PDF files, broken links, or random documents.
- Ignore general city homepages unless they are clearly the only permit portal.
- The "url" should be the most direct portal page, not the generic city homepage.
  `;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt
  });

  // Responses API: grab text from first output
  let textOutput = "";
  try {
    if (response.output && response.output.length > 0) {
      const first = response.output[0];
      if (first.content && first.content.length > 0) {
        const t = first.content[0].text;
        textOutput = typeof t === "string" ? t : t?.value || "";
      }
    }
  } catch {
    textOutput = "";
  }

  // Fallback if client exposes output_text
  if (!textOutput && response.output_text) {
    textOutput = response.output_text;
  }

  const parsed = extractJsonFromText(textOutput);

  if (parsed && typeof parsed === "object") {
    return {
      url: parsed.url || null,
      notes: parsed.notes || "Parsed from JSON"
    };
  }

  return {
    url: null,
    notes: "AI returned non-JSON",
    raw: textOutput
  };
}

// ---------- MAIN HANDLER ----------
export default async function handler(req, res) {
  try {
    // Optional: protect this endpoint when CRON_SECRET is set
    if (CRON_SECRET) {
      const authHeader = req.headers["authorization"] || "";
      if (authHeader !== `Bearer ${CRON_SECRET}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    console.log("🚀 Portal discovery cron fired");

    const today = new Date().toISOString().slice(0, 10);

    // ---- Check daily AI usage ----
    const usageRows = await sb(
      `portal_ai_usage?day=eq.${today}&limit=1`
    );
    const used = usageRows && usageRows[0] ? usageRows[0].count : 0;

    if (used >= DAILY_AI_LIMIT) {
      console.log(`🛑 Daily AI limit reached (${used}/${DAILY_AI_LIMIT}).`);
      return res.status(200).json({ status: "daily_limit_reached", used, DAILY_AI_LIMIT });
    }

    // ---- Get next jurisdiction without portal ----
    const pending = await sb("jurisdictions_without_portals?limit=1");
    if (!pending || pending.length === 0) {
      console.log("✨ No jurisdictions left without portals. Idle.");
      return res.status(200).json({ status: "idle", message: "No jurisdictions_without_portals remaining." });
    }

    const jur = pending[0];
    const readableName = `${jur.name}, ${jur.statefp}`;

    console.log("🔍 Discovering portal for:", jur.geoid, readableName);

    // ---- AI discovery ----
    const ai = await discoverPortalWithAI(readableName);
    const validUrl = validateURL(ai.url);
    const vendor = detectVendor(validUrl);

    console.log("AI candidate:", ai);

    // ---- Upsert jurisdiction_meta ----
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: jur.geoid,
      portal_url: validUrl,
      vendor_type: vendor,
      submission_method: validUrl ? "online" : "unknown",
      license_required: true,
      notes: ai.notes || "",
      raw_ai_output: ai,
      updated_at: new Date().toISOString()
    });

    // ---- Update daily usage ----
    if (!usageRows || usageRows.length === 0) {
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
