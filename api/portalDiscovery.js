import { AgentKit } from "@openai/agentkit";
import OpenAI from "openai";
import fetch from "node-fetch";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // MUST be service role
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------
   Helper: Supabase fetch wrapper
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

  const allowedVendors = [
    "accela.com",
    "energov",
    "etrakit",
    "citizenserve.com",
    "tylertech.com",
    "mygovernmentonline.org",
    "open.gov",
    "viewpointcloud",
    "cityview"
  ];

  const host = url.toLowerCase();

  if (host.endsWith(".gov")) return url;            // direct government site
  if (allowedVendors.some(v => host.includes(v))) return url;

  return null;
}

/* -------------------------------------------
   VENDOR DETECTOR
-------------------------------------------- */
function detectVendor(url) {
  if (!url) return null;

  const map = {
    accela: "accela.com",
    enerGov: "energov",
    eTrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech.com",
    myGOV: "mygovernmentonline.org",
    openGov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [vendor, keyword] of Object.entries(map)) {
    if (url.toLowerCase().includes(keyword)) return vendor;
  }

  if (url.endsWith(".gov")) return "municipal";  
  return "unknown";
}

/* -------------------------------------------
   AGENTKIT
-------------------------------------------- */
const agentKit = new AgentKit({
  client: openai,
  actions: {
    async deepResearch({ jurisdictionName }) {
      const query = `
      Find the OFFICIAL building permit portal for: "${jurisdictionName}"
      
      RULES:
      - Only return ONE URL
      - Must be .gov OR a known vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MGO)
      - Ignore PDFs, documents, and broken links
      - Ignore "general city homepage"
      - Prefer “permit portal”, “contractor login”, or “building permit system”
      - Return JSON only:
        { "url": "...", "notes": "..." }
      `;

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: query }]
      });

      try {
        return JSON.parse(result.choices[0].message.content);
      } catch {
        return { url: null, notes: "Parsing failed" };
      }
    }
  }
});

/* -------------------------------------------
   MAIN WORKER LOOP
-------------------------------------------- */
export async function handler() {
  // 1. Get next pending job
  const jobs = await sb(
    "portal_discovery_jobs?status=eq.pending&order=created_at.asc&limit=1"
  );
  if (jobs.length === 0) {
    console.log("No jobs left.");
    return;
  }

  const job = jobs[0];
  const geoid = job.jurisdiction_geoid;

  // 2. Get jurisdiction name
  const jurisdictions = await sb(
    `jurisdictions?geoid=eq.${geoid}&limit=1`
  );
  if (jurisdictions.length === 0) {
    console.error("Jurisdiction not found");
    return;
  }

  const jur = jurisdictions[0];
  const readableName = `${jur.name}, ${jur.statefp}`;

  // Mark as running
  await sb(`portal_discovery_jobs?id=eq.${job.id}`, "PATCH", {
    status: "running",
    attempts: job.attempts + 1
  });

  // 3. AI: Deep Research
  const result = await agentKit.run("deepResearch", {
    jurisdictionName: readableName
  });

  const aiURL = result?.url || null;
  const validURL = validateURL(aiURL);
  const vendor = detectVendor(validURL);

  // 4. Save results
  await sb(`portal_discovery_jobs?id=eq.${job.id}`, "PATCH", {
    status: validURL ? "success" : "failed",
    discovered_url: validURL,
    detected_vendor: vendor,
    raw_ai_result: result,
    updated_at: new Date().toISOString()
  });

  if (validURL) {
    // Upsert jurisdiction_meta
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: validURL,
      vendor_type: vendor,
      submission_method: vendor ? "online" : "unknown",
      license_required: true,
      notes: result?.notes || ""
    });
  }

  console.log("Worker done for:", geoid);
}
