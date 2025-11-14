// api/cron-portal.js
// Runs once per minute via Vercel Cron. Processes ONE jurisdiction per run.

export const config = {
  runtime: "nodejs",
};

import OpenAI from "openai";

// Supabase fetch helper (same logic you use in portal-discovery)
async function sb(path, method = "GET", body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "apikey": process.env.SUPABASE_SERVICE_ROLE,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Supabase Error: ${errorText}`);
  }

  return res.json();
}

// AI wrapper — simplified, no formatting params that cause model errors
async function aiLookup(jurisdictionName) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Simple, robust text input/output
  const prompt = `
Find the official permitting portal for:

${jurisdictionName}

Rules:
- Prefer .gov or known vendor systems (Accela, EnerGov, eTrakit, CitizenServe, Tyler, MGO)
- Return ONLY a JSON object like:
  {"url":"...", "notes":"..."}
- If unsure, use: {"url": null, "notes":"not found"}
`;

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
  });

  const text = response.output_text;

  // Hardening: strip code fences and try to parse
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return { url: null, notes: "AI did not return clean JSON", raw: cleaned };
  }
}

// Basic URL validator
function validateURL(url) {
  if (!url || typeof url !== "string") return null;
  const clean = url.trim();

  if (!clean.startsWith("http")) return null;
  if (!clean.includes(".")) return null;

  // Accept .gov or recognized vendors
  const allowed = [
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

  const lower = clean.toLowerCase();
  if (lower.endsWith(".gov")) return clean;
  if (allowed.some(v => lower.includes(v))) return clean;

  return null;
}

// Vendor detection
function detectVendor(url) {
  if (!url) return null;

  const lower = url.toLowerCase();

  const map = {
    accela: "accela",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    mgo: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpoint",
    cityview: "cityview",
  };

  for (const [label, match] of Object.entries(map)) {
    if (lower.includes(match)) return label;
  }

  if (lower.endsWith(".gov")) return "municipal";
  return "unknown";
}

// ---------------------------------------------------------------------------
// MAIN CRON WORKER
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    // Security: block external calls
    const incoming = req.headers["authorization"];
    const expected = `Bearer ${process.env.CRON_SECRET}`;

    if (incoming !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1. Get the next jurisdiction WITHOUT a portal entry
    const jobs = await sb(
      "jurisdictions?select=geoid,name,statefp&level=eq.place&order=geoid.asc&limit=1&jurisdiction_meta!inner=false",
      "GET"
    ).catch(() => []);

    if (!jobs || jobs.length === 0) {
      return res.status(200).json({ status: "done", message: "No jurisdictions left." });
    }

    const jur = jobs[0];
    const fullName = `${jur.name}, ${jur.statefp}`;

    // 2. AI lookup
    const ai = await aiLookup(fullName);

    const finalURL = validateURL(ai.url);
    const vendor = detectVendor(finalURL);

    // 3. Insert into jurisdiction_meta
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: jur.geoid,
      portal_url: finalURL,
      vendor_type: vendor,
      submission_method: finalURL ? "online" : "unknown",
      license_required: true,
      notes: ai.notes || "",
      raw_ai_output: ai,
    });

    return res.status(200).json({
      status: "processed",
      jurisdiction: fullName,
      url: finalURL,
      vendor,
    });

  } catch (err) {
    console.error("🔥 Cron Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
