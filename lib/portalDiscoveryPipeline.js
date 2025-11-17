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
// AI Prompts
// --------------------------------------------------------

function buildMiniPrompt(name, statefp) {
  return `
You are identifying the OFFICIAL building permit portal for:
"${name}, ${statefp}"

STRICT RULES:
- Return ONE URL or null.
- Return ONLY a .gov domain OR a known vendor domain:
  Accela, EnerGov, TylerTech, eTrakit, CitizenServe, OpenGov, CityView,
  MyGovernmentOnline, PermitEyes, ViewPointCloud, ESRI/ArcGIS.
- Prefer pages that explicitly allow online permit applications.
- Do NOT return PDFs, document lists, About pages, meetings, or agendas.
- If login redirects to a vendor SSO (TylerPortico etc) return the underlying portal.
- Be conservative: if unsure → url=null.

Return JSON ONLY:

{
  "url": "<string|null>",
  "confidence": <0-1 number>,
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
- Must be a .gov page OR one of the verified vendor portals:
  Accela, EnerGov (TylerHost), TylerTech, eTrakit, CitizenServe,
  OpenGov, CityView, MyGovernmentOnline, PermitEyes, ViewPointCloud,
  ESRI WebGIS, ArcGIS.
- If the jurisdiction uses a vendor login redirect (e.g. TylerPortico OAuth),
  extract the final portal base (e.g. https://xxx-energovpub.tylerhost.net/apps/selfservice/).
- Avoid PDFs or "Applications & Forms" pages.
- Prefer pages with “permit”, “apply”, “application”, “contractor”, “portal”, “self-service”.
Return JSON ONLY:

{
  "url": "<string|null>",
  "confidence": <0-1 number>,
  "notes": "<short detailed reasoning>"
}
`;
}

// --------------------------------------------------------
// OpenAI execution helpers
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
      console.warn("[Portal AI] gpt-4.1 quota hit, falling back to mini model");
      return runMiniAI(name, statefp);
    }
    throw err;
  }
}

// --------------------------------------------------------
// Normalization / Validation Logic
// --------------------------------------------------------

async function validateCandidate(url) {
  if (!url) return null;

  // Fix Tyler OAuth redirects → canonical EnerGov SelfService URL
  const normalized = normalizeTylerOAuth(url);
  if (normalized) url = normalized;

  // Ensure it’s a valid URL for our whitelisted vendor list
  let validated = validateURL(url);
  if (!validated) return null;

  // Check that URL responds
  const alive = await checkUrlAlive(validated);
  if (!alive) return null;

  // Page-level content sanity check:
  const looksPortal = await looksLikePermitPortal(validated);
  if (!looksPortal) return null;

  return validated;
}

// --------------------------------------------------------
// SUPABASE UPSERT
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

  // 1. Load jurisdiction record
  const jRows = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
  if (!jRows.length) throw new Error(`Jurisdiction not found: ${geoid}`);

  const jur = jRows[0];
  const name = jur.name;
  const statefp = jur.statefp || "";

  // 2. CACHE CHECK
  if (!forceRefresh) {
    const meta = await sb(
      `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
    );

    if (meta.length && meta[0].portal_url) {
      return {
        status: "cache",
        portal_url: meta[0].portal_url,
        vendor_type: meta[0].vendor_type || "unknown",
        notes: meta[0].notes || "",
        source: "cached"
      };
    }
  }

  // 3. MINI AI
  const mini = await runMiniAI(name, statefp);
  let candidate = await validateCandidate(mini.url);
  let notes = mini.notes || "";
  let source = "mini";

  // 4. ESCALATE IF NECESSARY
  const miniConfidence = mini.confidence || 0;

  const needsEscalation =
    !candidate ||
    miniConfidence < 0.70 ||
    (mini.url && mini.url.includes("authorize?")); // OAuth redirect cases

  if (needsEscalation) {
    const full = await runFullAI(name, statefp);
    const fullCandidate = await validateCandidate(full.url);

    if (fullCandidate && (full.confidence >= miniConfidence)) {
      candidate = fullCandidate;
      notes = full.notes || notes;
      source = "full";
    }
  }

  // 5. IF NO CANDIDATE → FAIL + LOG FOR HUMAN REVIEW
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

  // 6. SUCCESS → determine vendor + write meta
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
