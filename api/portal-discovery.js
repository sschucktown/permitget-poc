// api/portal-discovery.js
export const config = {
  runtime: "nodejs18.x"
};

import OpenAI from "openai";

// ---------- ENV ----------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DAILY_AI_LIMIT = parseInt(process.env.DAILY_AI_LIMIT || "25"); // safety cap

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ---------- SUPABASE FETCH WRAPPER ----------
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
    const err = await res.text();
    throw new Error(`Supabase Error: ${err}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- URL VALIDATOR ----------
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

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

  const l = url.toLowerCase();

  if (l.endsWith(".gov")) return url;
  if (vendors.some(v => l.includes(v))) return url;

  return null;
}

// ---------- VENDOR DETECTOR ----------
function detectVendor(url) {
  if (!url) return "unknown";

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

  const l = url.toLowerCase();
  for (const [v, key] of Object.entries(map)) {
    if (l.includes(key)) return v;
  }

  if (l.endsWith(".gov")) return "municipal";
  return "unknown";
}

// ---------- AI CALL ----------
async function discoverPortalWithAI(name, geoid) {
  const prompt = `
You are a building permit portal finder.

Return ONLY JSON:
{
  "url": "...",
  "notes": "..."
}

Rules:
- Must be an OFFICIAL permit portal.
- Prefer “permit portal”, “contractor login”, “online permitting”.
- Ignore PDFs or broken links.
- Ignore general city homepage.
Jurisdiction: ${name}
  `;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: { format: "json" } // REQUIRED
  });

  try {
    return JSON.parse(response.output_text);
  } catch {
    return { url: null, notes: "AI returned non-JSON" };
  }
}

// ---------- MAIN HANDLER ----------
export default async function handler(req, res) {
  try {
    console.log("🚀 Portal discovery cron started");

    // ---- DAILY COST SAFETY LIMIT ----
    const today = new Date().toISOString().slice(0, 10);

    const usage = await sb(
      `portal_ai_usage?day=eq.${today}&limit=1`
    );

    const used = usage?.[0]?.count || 0;

    if (used >= DAILY_AI_LIMIT) {
      console.log("🛑 Daily AI limit reached. Halting.");
      return res.status(200).json({ status: "daily_limit_reached" });
    }

    // ---- GET NEXT JURISDICTION WITHOUT PORTAL ----
    const pending = await sb(
      "jurisdictions_without_portals?limit=1"
    );

    if (!pending || pending.length === 0) {
      console.log("✨ No jurisdictions left. Idle mode.");
      return res.status(200).json({ status: "idle" });
    }

    const jur = pending[0];
    console.log("🔍 Processing:", jur.geoid, jur.name);

    // ---- AI LOOKUP ----
    const ai = await discoverPortalWithAI(jur.name, jur.geoid);
    const url = validateURL(ai.url);
    const vendor = detectVendor(url);

    console.log("AI RESULT:", ai);

    // ---- SAVE META ----
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: jur.geoid,
      portal_url: url,
      vendor_type: vendor,
      submission_method: url ? "online" : "unknown",
      license_required: true,
      notes: ai.notes || "",
      raw_ai_output: ai
    });

    // ---- UPDATE USAGE ----
    if (usage.length === 0) {
      await sb("portal_ai_usage", "POST", { day: today, count: 1 });
    } else {
      await sb(
        `portal_ai_usage?day=eq.${today}`,
        "PATCH",
        { count: used + 1 }
      );
    }

    return res.status(200).json({
      geoid: jur.geoid,
      name: jur.name,
      discovered_url: url,
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
