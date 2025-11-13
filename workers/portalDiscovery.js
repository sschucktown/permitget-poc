import OpenAI from "openai";
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* -------------------------------------------
   SUPABASE WRAPPER
-------------------------------------------- */
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
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }

  return res.json();
}

/* -------------------------------------------
   URL VALIDATOR
-------------------------------------------- */
function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const vendors = [
    "accela.com",
    "energov",
    "etrakit",
    "citizenserve.com",
    "tylertech.com",
    "mygovernmentonline.org",
    "opengov",
    "viewpointcloud",
    "cityview"
  ];

  const host = url.toLowerCase();

  if (host.endsWith(".gov")) return url;
  if (vendors.some(v => host.includes(v))) return url;

  return null;
}

/* -------------------------------------------
   VENDOR DETECTOR
-------------------------------------------- */
function detectVendor(url) {
  if (!url) return "unknown";

  const map = {
    accela: "accela.com",
    energov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech.com",
    mgo: "mygovernmentonline.org",
    opengov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  const lower = url.toLowerCase();
  for (const [vendor, match] of Object.entries(map)) {
    if (lower.includes(match)) return vendor;
  }

  if (lower.endsWith(".gov")) return "municipal";
  return "unknown";
}

/* -------------------------------------------
   AI DEEP RESEARCH (REAL IMPLEMENTATION)
-------------------------------------------- */
async function deepResearch(jurisdictionName) {
  const prompt = `
Find the SINGLE OFFICIAL building permit portal for:
"${jurisdictionName}"

Rules:
- Must be .gov or a known vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO)
- Ignore PDFs
- Ignore unrelated pages
- Prefer contractor login / permit center URLs
- Return ONLY JSON:

{
  "url": "...",
  "notes": "..."
}
`;

  const result = await client.responses.create({
    model: "gpt-4.1",
    input: prompt,
    response_format: {
      type: "json_schema",
      json_schema: {
        schema: {
          type: "object",
          properties: {
            url: { type: "string" },
            notes: { type: "string" }
          },
          required: ["url"]
        }
      }
    }
  });

  return result.output[0].content[0].json;
}

/* -------------------------------------------
   MAIN WORKER
-------------------------------------------- */
export async function handler() {
  // 1. Fetch next job
  const jobs = await sb(
    "portal_discovery_jobs?status=eq.pending&order=created_at.asc&limit=1"
  );
  if (jobs.length === 0) return;

  const job = jobs[0];
  const geoid = job.jurisdiction_geoid;

  // 2. Update job → running
  await sb(`portal_discovery_jobs?id=eq.${job.id}`, "PATCH", {
    status: "running",
    attempts: job.attempts + 1
  });

  // 3. Fetch jurisdiction
  const [jur] = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
  const name = `${jur.name}, ${jur.statefp}`;

  // 4. AI deep research
  const ai = await deepResearch(name);

  const validURL = validateURL(ai.url);
  const vendor = detectVendor(validURL);

  // 5. Update job
  await sb(`portal_discovery_jobs?id=eq.${job.id}`, "PATCH", {
    status: validURL ? "success" : "failed",
    discovered_url: validURL,
    detected_vendor: vendor,
    raw_ai_result: ai,
    updated_at: new Date().toISOString()
  });

  // 6. Write to jurisdiction_meta
  if (validURL) {
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: validURL,
      vendor_type: vendor,
      submission_method: vendor ? "online" : "unknown",
      license_required: true,
      notes: ai.notes || ""
    });
  }

  console.log("Worker completed", geoid);
}
