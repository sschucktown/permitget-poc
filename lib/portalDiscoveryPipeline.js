// lib/portalDiscoveryPipeline.js
import OpenAI from "openai";
import { sb } from "./supabase.js";
import {
  validateURL,
  detectVendor,
  checkUrlAlive,
  looksLikePermitPortal,
  normalizeTylerOAuth
} from "./portalUtils.js";

// --------------------------------------------------------
// OpenAI client
// --------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --------------------------------------------------------
// PROMPTS
// --------------------------------------------------------

function buildMiniPrompt(name, statefp) {
  return `
You are identifying the OFFICIAL building permit portal for:
"${name}, ${statefp}"

STRICT RULES:
- Return ONE URL or null.
- The URL MUST be either:
    • a .gov site, OR
    • a known permit vendor:
      Accela, EnerGov/TylerTech, eTrakit, CitizenServe, OpenGov, CityView,
      MyGovernmentOnline, PermitEyes, ViewPointCloud, ESRI/ArcGIS WebGIS.
- Prefer URLs that explicitly allow online permit applications.
- Avoid PDFs, “forms & documents” pages, agendas, minutes, or zoning pages.
- If login redirects to a vendor SSO (e.g., TylerPortico), return the underlying portal.
- If unsure, return null.

Return JSON ONLY:

{
  "url": "<string|null>",
  "confidence": <number between 0 and 1>,
  "notes": "<short reasoning>"
}
`;
}

function buildFullPrompt(name, statefp) {
  return `
You are performing a careful, accurate investigation to determine the OFFICIAL online building permit portal used by contractors for:
"${name}, ${statefp}"

STRICT RULES:
- Return ONE URL or null.
- Allowed categories:
    • Government (.gov)
    • Accela
    • EnerGov / TylerTech / TylerHost / TylerPortico
    • eTrakit
    • CitizenServe
    • OpenGov
    • MyGovernmentOnline
    • CityView (CVProdPortal)
    • PermitEyes
    • ViewPointCloud
    • ArcGIS / ESRI WebGIS instances
- If the jurisdiction uses a vendor login redirect (e.g., TylerPortico OAuth),
  extract the final portal base:
  Example:
    identity.tylerportico.com → https://xxx-energovpub.tylerhost.net/apps/selfservice/
- Avoid PDFs, About pages, agendas, minutes, zoning-only pages.
- Prefer pages with “apply”, “permit”, “contractor login”, “self-service”.

Return JSON ONLY:

{
  "url": "<string|null>",
  "confidence": <number between 0 and 1>,
  "notes": "<short detailed reasoning>"
}
`;
}

// --------------------------------------------------------
// AI EXEC HELPERS
// --------------------------------------------------------

async function runMiniAI(name, statefp) {
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: buildMiniPrompt(name, statefp),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "miniPortalSchema",
        schema: {
          type: "object",
          properties: {
            url: { type: ["string", "null"] },
            confidence: { type: "number" },
            notes: { type: ["string", "null"] }
          },
          required: ["url", "confidence"]
        }
      }
    }
  });

  return response.output[0].content[0].json;
}

async function runFullAI(name, statefp) {
  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      input: buildFullPrompt(name, statefp),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fullPortalSchema",
          schema: {
            type: "object",
            properties: {
              url: { type: ["string", "null"] },
              confidence: { type: "number" },
              notes: { type: ["string", "null"] }
            },
            required: ["url", "confidence"]
          }
        }
      }
    });

    return response.output[0].content[0].json;

  } catch (err) {
    if (err.status === 429 || err.code === "insufficient_quota") {
      console.warn("[PortalDiscovery] gpt-4.1 quota hit → falling back to mini");
      return runMiniAI(name, statefp);
    }
    throw err;
  }
}

// --------------------------------------------------------
// NORMALIZATION + VALIDATION
// --------------------------------------------------------

/**
 * Canonicalizes and validates a candidate URL.
 */
async function validateCandidate(rawUrl) {
  if (!rawUrl) return null;
  let url = rawUrl;

  // Normalize Tyler OAuth → EnerGov self-service
  const normalizedTyler = normalizeTylerOAuth(url);
  if (normalizedTyler) url = normalizedTyler;

  // Normalize CityView login URLs
  if (url.toLowerCase().includes("cvprodportal")) {
    url = url.replace(/\/Account\/Logon.*/i, "/");
  }

  // Ensure it's a valid vendor or .gov domain
  const validated = validateURL(url);
  if (!validated) return null;

  // HEAD check for page existence
  const alive = await checkUrlAlive(validated);
  if (!alive) return null;

  // Light content sniff test
  const looksPortalPage = await looksLikePermitPortal(validated);
  if (!looksPortalPage) return null;

  return validated;
}

// --------------------------------------------------------
// SUPABASE META UPSERT
// --------------------------------------------------------

async function upsertMeta(geoid, portal_url, vendor_type, notes) {
  await sb("jurisdiction_meta?on_conflict=jurisdiction_geoid", "POST", {
    jurisdiction_geoid: geoid,
    portal_url,
    vendor_type,
    submission_method: portal_url ? "online" : "unknown",
    license_required: portal_url ? true : null,
    notes: notes || ""
  });
}

// --------------------------------------------------------
// MAIN PIPELINE
// --------------------------------------------------------

export async function runPortalDiscovery({ geoid, forceRefresh = false }) {
  if (!geoid) throw new Error("Missing geoid");

  // 1. Load jurisdiction
  const jRows = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
  if (!jRows.length) throw new Error(`Jurisdiction not found: ${geoid}`);

  const jur = jRows[0];
  const name = jur.name;
  const statefp = jur.statefp || "";

  // 2. CACHE CHECK
  if (!forceRefresh) {
    const cached = await sb(
      `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
    );

    if (cached.length && cached[0].portal_url) {
      return {
        status: "cache",
        portal_url: cached[0].portal_url,
        vendor_type: cached[0].vendor_type || "unknown",
        notes: cached[0].notes || "",
        source: "cached"
      };
    }
  }

  // 3. MINI AI ROUND
  const mini = await runMiniAI(name, statefp);
  let candidate = await validateCandidate(mini.url);
  let notes = mini.notes || "";
  let source = "mini";

  const miniConfidence = mini.confidence || 0;

  // 4. ESCALATE IF NECESSARY
  const requiresEscalation =
    !candidate ||
    miniConfidence < 0.7 ||
    (mini.url && mini.url.includes("authorize?")); // OAuth → must escalate

  if (requiresEscalation) {
    const full = await runFullAI(name, statefp);
    const fullCandidate = await validateCandidate(full.url);

    if (fullCandidate && full.confidence >= miniConfidence) {
      candidate = fullCandidate;
      notes = full.notes || notes;
      source = "full";
    }
  }

  // 5. FAILURE → record for human review
  if (!candidate) {
    await upsertMeta(
      geoid,
      null,
      "unknown",
      notes || "No reliable portal identified"
    );

    return {
      status: "none",
      portal_url: null,
      vendor_type: "unknown",
      notes
    };
  }

  // 6. SUCCESS → vendor detection + upsert
  const vendor = detectVendor(candidate);

  await upsertMeta(
    geoid,
    candidate,
    vendor,
    notes
  );

  return {
    status: source,
    portal_url: candidate,
    vendor_type: vendor,
    notes
  };
}
