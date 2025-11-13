// api/portal-discovery.js
// Vercel Node serverless function – ES module style

import OpenAI from "openai";

// ---- ENV CONFIG ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

// Basic sanity check
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.warn(
    "[portal-discovery] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE(_KEY) env vars."
  );
}

/* -------------------------------
   Supabase REST helper
-------------------------------- */
async function sb(path, { method = "GET", query = "", body } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}${query ? `?${query}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase error ${res.status} ${res.statusText} for ${path}: ${text}`
    );
  }

  // Some Supabase calls return empty body (204)
  if (res.status === 204) return null;

  return res.json();
}

/* -------------------------------
   URL validation & vendor detection
-------------------------------- */
const KNOWN_VENDOR_KEYWORDS = {
  accela: "accela",
  energov: "energov",
  etrakit: "etrakit",
  citizenserve: "citizenserve",
  tyler: "tylertech",
  mygov: "mygovernmentonline",
  opengov: "opengov",
  viewpoint: "viewpointcloud",
  cityview: "cityview"
};

function validateURL(url) {
  if (!url || typeof url !== "string") return null;

  let trimmed = url.trim();

  // Add scheme if missing
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    trimmed = "https://" + trimmed;
  }

  try {
    const u = new URL(trimmed);

    // Must have a hostname with a dot
    if (!u.hostname || !u.hostname.includes(".")) return null;

    // Allow direct .gov or .state.xx.us domains
    if (u.hostname.endsWith(".gov") || u.hostname.includes(".state.")) {
      return u.toString();
    }

    // Allow known vendors
    const host = u.hostname.toLowerCase();
    const isKnown = Object.values(KNOWN_VENDOR_KEYWORDS).some((kw) =>
      host.includes(kw)
    );
    if (isKnown) return u.toString();

    return null;
  } catch {
    return null;
  }
}

function detectVendor(url) {
  if (!url) return null;
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();

  if (host.endsWith(".gov") || host.includes(".state.")) return "municipal";

  for (const [vendor, kw] of Object.entries(KNOWN_VENDOR_KEYWORDS)) {
    if (host.includes(kw)) return vendor;
  }

  return "unknown";
}

/* -------------------------------
   AI helper – find portal URL
   Uses chat.completions (no Responses API)
-------------------------------- */
async function discoverPortalWithAI(jurisdiction) {
  const { name, statefp, level } = jurisdiction;

  const readableName =
    level === "state" ? name : `${name}, ${statefp ?? ""}`.trim();

  const prompt = `
You are helping find the OFFICIAL online building permit portal.

Jurisdiction: "${readableName}"
Level: ${level || "unknown"}

Return ONLY a JSON object, nothing else, in this shape:
{
  "url": "https://...",
  "notes": "short explanation of why this URL is correct"
}

Rules:
- Prefer .gov domains or official subdomains.
- If the jurisdiction uses a SaaS vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MyGovernmentOnline, ViewpointCloud, CityView),
  return the direct contractor/permit portal URL.
- Avoid generic city homepages when possible.
- Avoid PDFs, random documents, or unrelated pages.
- If you truly cannot find a clear portal, use:
  { "url": null, "notes": "reason" }.
`.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a strict JSON API. Always respond with a single JSON object and no additional text."
      },
      { role: "user", content: prompt }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || "";

  // Try to salvage JSON if there's any extra noise
  let jsonText = raw;
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonText = raw.slice(firstBrace, lastBrace + 1);
  }

  let parsed = {};
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error("[portal-discovery] JSON parse failed:", err, "raw:", raw);
    parsed = { url: null, notes: "AI JSON parse failed" };
  }

  // Normalise
  let url = null;
  let notes = "";

  if (typeof parsed === "string") {
    url = parsed;
  } else {
    url = parsed.url ?? null;
    notes = parsed.notes ?? "";
  }

  return { url, notes, raw };
}

/* -------------------------------
   Supabase data helpers
-------------------------------- */
async function getJurisdictionByGeoid(geoid) {
  const rows = await sb("jurisdictions", {
    query: `geoid=eq.${encodeURIComponent(geoid)}&limit=1`
  });
  return rows[0] || null;
}

async function getMetaForGeoid(geoid) {
  const rows = await sb("jurisdiction_meta", {
    query: `jurisdiction_geoid=eq.${encodeURIComponent(geoid)}&limit=1`
  });
  return rows[0] || null;
}

async function upsertMetaForGeoid(geoid, { portal_url, vendor_type, notes }) {
  const body = [
    {
      jurisdiction_geoid: geoid,
      portal_url,
      vendor_type,
      submission_method: portal_url ? "online" : null,
      license_required: portal_url ? true : null,
      notes: notes || "",
      last_confirmed_at: new Date().toISOString()
    }
  ];

  await sb("jurisdiction_meta", {
    method: "POST",
    body,
    // merge on conflict by jurisdiction_geoid
    query: "on_conflict=jurisdiction_geoid"
  });
}

/* -------------------------------
   MAIN HANDLER
-------------------------------- */
export default async function handler(req, res) {
  try {
    const { geoid } = req.query || {};

    if (!geoid) {
      res.status(400).json({ error: "Missing required query param: geoid" });
      return;
    }

    console.log("[portal-discovery] Starting for geoid:", geoid);

    // 1) Get jurisdiction
    const jur = await getJurisdictionByGeoid(geoid);
    if (!jur) {
      res.status(404).json({ error: "Jurisdiction not found", geoid });
      return;
    }

    // 2) Check existing meta (to avoid re-hitting AI)
    const existingMeta = await getMetaForGeoid(geoid);
    if (existingMeta && existingMeta.portal_url) {
      console.log(
        "[portal-discovery] Portal already known for",
        geoid,
        "=>",
        existingMeta.portal_url
      );
      res.status(200).json({
        geoid,
        name: jur.name,
        discovered_url: existingMeta.portal_url,
        vendor: existingMeta.vendor_type,
        raw_ai_output: null,
        cached: true
      });
      return;
    }

    // 3) Call AI to discover portal
    const aiResult = await discoverPortalWithAI(jur);
    const validatedUrl = validateURL(aiResult.url);
    const vendor = validatedUrl ? detectVendor(validatedUrl) : null;

    // 4) Persist result (even if URL is null, we store notes + last_confirmed_at)
    await upsertMetaForGeoid(geoid, {
      portal_url: validatedUrl,
      vendor_type: vendor,
      notes: aiResult.notes
    });

    console.log(
      "[portal-discovery] Done for",
      geoid,
      "=>",
      validatedUrl || "NO URL"
    );

    res.status(200).json({
      geoid,
      name: jur.name,
      discovered_url: validatedUrl,
      vendor,
      raw_ai_output: aiResult.raw
    });
  } catch (err) {
    console.error("🔥 [portal-discovery] Error:", err);
    // Try to send a safe error JSON
    res
      .status(500)
      .json({ error: "Internal error", message: err.message ?? String(err) });
  }
}
