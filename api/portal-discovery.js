export const config = {
  runtime: "nodejs",
};

import OpenAI from "openai";

// -------------------------------
// Environment
// -------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// -------------------------------
// Safe Supabase wrapper
// -------------------------------
async function sb(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase Error: ${text}`);
  }

  const text = await res.text();
  if (!text) return null;

  try { return JSON.parse(text); }
  catch { return text; }
}

// -------------------------------
// URL validation
// -------------------------------
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;

  const bad = ["mailto:", "javascript:"];
  if (bad.some(p => url.startsWith(p))) return null;

  return url;
}

// -------------------------------
// Vendor detection
// -------------------------------
function detectVendor(url) {
  if (!url) return null;
  const u = url.toLowerCase();

  const map = {
    accela: "accela",
    enerGov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve",
    tyler: "tylertech",
    opengov: "opengov",
    mgo: "mygovernmentonline",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [vendor, key] of Object.entries(map)) {
    if (u.includes(key)) return vendor;
  }

  if (u.endsWith(".gov")) return "municipal";
  return "unknown";
}

// -------------------------------
// AI function
// -------------------------------
async function discoverPortalWithAI(name) {
  const query = `
  Find the **official building permit portal** for **${name}**.

  Return JSON like:
  { "url": "...", "notes": "..." }
  `;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: query
  });

  const text = response.output_text || "";

  // Extract JSON safely
  const match = text.match(/\{[\s\S]*\}/);
  
  if (!match) {
    return {
      url: null,
      notes: "AI did not return JSON",
      raw: text
    };
  }

  try {
    const parsed = JSON.parse(match[0]);
    return { ...parsed, raw: text };
  } catch {
    return {
      url: null,
      notes: "JSON parse failed",
      raw: text
    };
  }
}

// -------------------------------
// Worker: process 1 job
// -------------------------------
export default async function handler(req, res) {
  try {
    // 1. Get oldest pending job
    const jobs = await sb(
      "portal_discovery_jobs?status=eq.pending&order=created_at.asc&limit=1"
    );

    if (!jobs || jobs.length === 0) {
      return res.status(200).json({ message: "No pending jobs." });
    }

    const job = jobs[0];

    // 2. Get jurisdiction
    const j = await sb(
      `jurisdictions?geoid=eq.${job.jurisdiction_geoid}&limit=1`
    );

    if (!j || j.length === 0) {
      return res.status(404).json({ error: "Jurisdiction not found" });
    }

    const jur = j[0];
    const readableName = `${jur.name}, ${jur.state_code || ""}`.trim();

    // Mark job running
    await sb(
      `portal_discovery_jobs?id=eq.${job.id}`,
      "PATCH",
      {
        status: "running",
        attempts: job.attempts + 1,
        updated_at: new Date().toISOString()
      }
    );

    // 3. AI search
    const ai = await discoverPortalWithAI(readableName);

    const cleanURL = validateURL(ai.url);
    const vendor = detectVendor(cleanURL);

    // 4. Update job status
    await sb(
      `portal_discovery_jobs?id=eq.${job.id}`,
      "PATCH",
      {
        status: cleanURL ? "success" : "failed",
        discovered_url: cleanURL,
        detected_vendor: vendor,
        raw_ai_output: ai,
        updated_at: new Date().toISOString()
      }
    );

    // 5. Insert into jurisdiction_meta
    if (cleanURL) {
      await sb(
        "jurisdiction_meta",
        "POST",
        {
          jurisdiction_geoid: job.jurisdiction_geoid,
          portal_url: cleanURL,
          vendor_type: vendor,
          submission_method: "online",
          license_required: true,
          raw_ai_output: ai
        }
      );
    }

    return res.status(200).json({
      geoid: job.jurisdiction_geoid,
      name: jur.name,
      discovered_url: cleanURL,
      vendor,
      raw_ai_output: ai
    });

  } catch (err) {
    console.error("🔥 Worker Error:", err);
    return res.status(500).json({ error: "Internal error", message: err.message });
  }
}
