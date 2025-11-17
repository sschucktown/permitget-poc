// lib/portalDiscoveryPipeline.js
import OpenAI from "openai";
import { sb } from "./supabase.js";
import {
  validateURL,
  detectVendor,
  checkUrlAlive,
  looksLikePermitPortal
} from "./portalUtils.js";

import { classifyOffline } from "./offlineClassifier.js";
import { extractLinksFromHTML, fetchPageHTML } from "./webUtils.js"; // (I can generate this if you need)
import { enhancedVendorDetect } from "./vendorHeuristics.js";        // (optional heuristics module)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// -----------------------------------------------------------------------------
// AI HELPERS
// -----------------------------------------------------------------------------

async function miniResearchPortal(jurisdictionName, statefp) {
  const prompt = `
You are finding the OFFICIAL online building permit portal for:

"${jurisdictionName}, ${statefp}"

Rules:
- Return ONE URL or null.
- It must be a .gov domain OR a known vendor
  (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MyGovernmentOnline, CityView, PermitEyes).
- Prefer "permit center", "contractor login", "citizen access", "building permits".
- Ignore PDFs, file managers, and random documents.

Return strict JSON:
{
  "url": "<string or null>",
  "confidence": <0–1 number>,
  "notes": "<reason>"
}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "PortalResearch",
        schema: {
          type: "object",
          properties: {
            url: { type: ["string", "null"] },
            confidence: { type: "number" },
            notes: { type: "string" }
          },
          required: ["url", "confidence"]
        }
      }
    }
  });

  return response.output[0].content[0].json;
}

async function fullPowerResearchPortal(jurisdictionName, statefp) {
  const prompt = `
You are doing a careful search for the OFFICIAL contractor-facing online permit portal for:

"${jurisdictionName}, ${statefp}"

Rules:
- Return ONE URL or null.
- Must be .gov OR a real permit vendor system.
- Prefer real portal URLs, ignoring PDFs.
- Avoid generic "files/" directories.

Return JSON:
{
  "url": "<string or null>",
  "confidence": <0–1>,
  "notes": "<reason>"
}
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      input: prompt,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "PortalResearch",
          schema: {
            type: "object",
            properties: {
              url: { type: ["string", "null"] },
              confidence: { type: "number" },
              notes: { type: "string" }
            },
            required: ["url", "confidence"]
          }
        }
      }
    });

    return response.output[0].content[0].json;
  } catch (err) {
    if (err.status === 429) {
      console.warn("[portal] Full model quota hit; falling back");
      return miniResearchPortal(jurisdictionName, statefp);
    }
    throw err;
  }
}

// -----------------------------------------------------------------------------
// MAIN PIPELINE (UPDATED)
// -----------------------------------------------------------------------------

export async function runPortalDiscovery({ geoid, forceRefresh = false }) {
  if (!geoid) throw new Error("Missing geoid");

  // 1. Load jurisdiction
  const jurRes = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
  if (!jurRes.length) throw new Error(`Jurisdiction ${geoid} not found`);

  const jur = jurRes[0];
  const readableName = jur.name;
  const statefp = jur.statefp || "";

  // ---------------------------------------------------------------------------
  // 2. CACHE CHECK
  // ---------------------------------------------------------------------------

  if (!forceRefresh) {
    const metaRes = await sb(
      `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1&order=created_at.desc`
    );

    if (metaRes.length && metaRes[0].portal_url) {
      return {
        status: "cache",
        portal_url: metaRes[0].portal_url,
        vendor_type: metaRes[0].vendor_type,
        submission_method: metaRes[0].submission_method,
        notes: metaRes[0].notes || "cached"
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 3. OFFLINE CLASSIFIER (NEW!)
  // ---------------------------------------------------------------------------

  // Fetch website and extract links
  const homeUrl = jur.homepage_url || jur.website || null;
  let offlineDecision = null;

  if (homeUrl) {
    const html = await fetchPageHTML(homeUrl);
    const links = extractLinksFromHTML(html);

    offlineDecision = classifyOffline(html, links);

    if (offlineDecision.isOffline) {
      const primaryPage =
        jur.codes_page ||
        jur.permits_page ||
        links.find(l => l.text.includes("permit"))?.url ||
        homeUrl;

      await sb("jurisdiction_meta?on_conflict=jurisdiction_geoid", "POST", {
        jurisdiction_geoid: geoid,
        portal_url: primaryPage,
        vendor_type: "offline",
        submission_method: "offline",
        verified: true,
        verified_at: new Date().toISOString(),
        notes: "Auto-classified as offline jurisdiction (PDF-only).",
      });

      return {
        status: "offline",
        portal_url: primaryPage,
        vendor_type: "offline",
        submission_method: "offline",
        confidence: offlineDecision.confidence,
        notes: "Jurisdiction uses PDF/in-person permitting only."
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 4. MINI AI ATTEMPT
  // ---------------------------------------------------------------------------

  const mini = await miniResearchPortal(readableName, statefp);

  let candidateUrl = validateURL(mini.url);
  let source = "mini";
  let notes = mini.notes || "";

  // ---------------------------------------------------------------------------
  // 5. VERIFY MINI RESULT
  // ---------------------------------------------------------------------------

  const triedMini = candidateUrl
    ? {
        alive: await checkUrlAlive(candidateUrl),
        portal: await looksLikePermitPortal(candidateUrl)
      }
    : null;

  const miniGood =
    triedMini && triedMini.alive && triedMini.portal && mini.confidence >= 0.7;

  if (!miniGood) {
    // Try full
    const full = await fullPowerResearchPortal(readableName, statefp);
    const fullUrl = validateURL(full.url);

    if (fullUrl) {
      const alive = await checkUrlAlive(fullUrl);
      const portalOK = await looksLikePermitPortal(fullUrl);

      if (alive && portalOK && full.confidence >= mini.confidence) {
        candidateUrl = fullUrl;
        source = "full";
        notes = full.notes || notes;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 6. STILL NOTHING → Record & Exit
  // ---------------------------------------------------------------------------

  if (!candidateUrl) {
    await sb("jurisdiction_meta?on_conflict=jurisdiction_geoid", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: null,
      vendor_type: "unknown",
      submission_method: "unknown",
      notes: notes || "AI was not confident for this jurisdiction."
    });

    return {
      status: "none",
      portal_url: null,
      vendor_type: "unknown",
      notes
    };
  }

  // ---------------------------------------------------------------------------
  // 7. FINAL VENDOR DETECTION (UPDATED!)
  // ---------------------------------------------------------------------------

  const vendor =
    enhancedVendorDetect(candidateUrl) || detectVendor(candidateUrl);

  // ---------------------------------------------------------------------------
  // 8. UPSERT (CACHE FOR FUTURE LOOKUPS)
  // ---------------------------------------------------------------------------

  await sb("jurisdiction_meta?on_conflict=jurisdiction_geoid", "POST", {
    jurisdiction_geoid: geoid,
    portal_url: candidateUrl,
    vendor_type: vendor,
    submission_method: "online",
    notes
  });

  return {
    status: source,
    portal_url: candidateUrl,
    vendor_type: vendor,
    submission_method: "online",
    notes
  };
}

