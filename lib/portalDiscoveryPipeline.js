// lib/portalDiscoveryPipeline.js
import OpenAI from "openai";
import { sb } from "./supabase.js";
import { validateURL, detectVendor, checkUrlAlive, looksLikePermitPortal } from "./portalUtils.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function miniResearchPortal(jurisdictionName, statefp) {
  const prompt = `
You are finding the OFFICIAL online building permit portal for:

"${jurisdictionName}, ${statefp}"

Rules:
- Return ONE URL or null.
- It must be either a .gov domain OR a known permit vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MyGovernmentOnline, CityView).
- Prefer "permit center", "contractor login", "citizen access", "building permits".
- Ignore PDFs and random documents.
Return JSON only:

{
  "url": "<string or null>",
  "confidence": <number between 0 and 1>,
  "notes": "<short reasoning>"
}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "PortalResearchResult",
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

  const content = response.output[0].content[0].json;
  return content;
}

async function fullPowerResearchPortal(jurisdictionName, statefp) {
  const prompt = `
You are doing a careful, accurate search for the OFFICIAL online building permit portal used by contractors for:

"${jurisdictionName}, ${statefp}"

Rules:
- Return ONE URL or null.
- It must be either a .gov domain OR a known permit vendor (Accela, EnerGov, eTrakit, CitizenServe, Tyler, OpenGov, MyGovernmentOnline, CityView).
- Prefer dedicated permit center / contractor login / permit portal URLs.
- Ignore PDFs and unrelated pages.
Return JSON only:

{
  "url": "<string or null>",
  "confidence": <number between 0 and 1>,
  "notes": "<short detailed reasoning>"
}
`;

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      input: prompt,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "PortalResearchResult",
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
    // handle quota / 429 gracefully: fall back to mini
    if (err.status === 429 || err.code === "insufficient_quota") {
      console.warn("[portal] 4.1 quota hit — falling back to mini model");
      return miniResearchPortal(jurisdictionName, statefp);
    }
    throw err;
  }
}

/**
 * Main pipeline: run portal discovery for a single jurisdiction by geoid.
 * Returns an object with:
 * - status: 'cache' | 'mini' | 'full' | 'none'
 * - portal_url
 * - vendor_type
 * - notes
 */
export async function runPortalDiscovery({ geoid, forceRefresh = false }) {
  if (!geoid) {
    throw new Error("Missing geoid");
  }

  // 1. Load jurisdiction
  const jurRes = await sb(`jurisdictions?geoid=eq.${geoid}&limit=1`);
  if (!jurRes.length) {
    throw new Error(`Jurisdiction not found for geoid ${geoid}`);
  }
  const jur = jurRes[0];
  const readableName = jur.name;
  const statefp = jur.statefp || "";

  // 2. CACHE CHECK (Stage 0)
  if (!forceRefresh) {
    const metaRes = await sb(
      `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
    );

    if (metaRes.length && metaRes[0].portal_url) {
      return {
        status: "cache",
        portal_url: metaRes[0].portal_url,
        vendor_type: metaRes[0].vendor_type,
        notes: metaRes[0].notes || "",
        source: "cached"
      };
    }
  }

  // 3. MINI AI (cheap) (Stage 4)
  const mini = await miniResearchPortal(readableName, statefp);
  let candidateUrl = validateURL(mini.url);
  let source = "mini";
  let notes = mini.notes || "";

  // 4. Verify candidate (Stage 5)
  if (candidateUrl) {
    const alive = await checkUrlAlive(candidateUrl);
    const looksPortal = alive ? await looksLikePermitPortal(candidateUrl) : false;

    if (!alive || !looksPortal || mini.confidence < 0.7) {
      // escalate to fullPower
      const full = await fullPowerResearchPortal(readableName, statefp);
      const fullUrl = validateURL(full.url);
      if (fullUrl) {
        const fullAlive = await checkUrlAlive(fullUrl);
        const fullLooksPortal = fullAlive ? await looksLikePermitPortal(fullUrl) : false;

        if (fullAlive && fullLooksPortal && full.confidence >= mini.confidence) {
          candidateUrl = fullUrl;
          source = "full";
          notes = full.notes || notes;
        }
      }
    }
  } else {
    // no candidate from mini → try fullPower
    const full = await fullPowerResearchPortal(readableName, statefp);
    const fullUrl = validateURL(full.url);
    if (fullUrl) {
      const fullAlive = await checkUrlAlive(fullUrl);
      const fullLooksPortal = fullAlive ? await looksLikePermitPortal(fullUrl) : false;
      if (fullAlive && fullLooksPortal) {
        candidateUrl = fullUrl;
        source = "full";
        notes = full.notes || "";
      }
    }
  }

  // 5. If still nothing → record "none" and bail (Stage 7 / human)
  if (!candidateUrl) {
    // Record failed attempt in meta (optional)
    await sb("jurisdiction_meta?on_conflict=jurisdiction_geoid", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: null,
      vendor_type: "unknown",
      submission_method: "unknown",
      license_required: null,
      notes: notes || "No reliable portal found via AI"
    });

    return {
      status: "none",
      portal_url: null,
      vendor_type: "unknown",
      notes
    };
  }

  const vendor = detectVendor(candidateUrl);

  // 6. Upsert into jurisdiction_meta (cache for future calls)
  await sb("jurisdiction_meta?on_conflict=jurisdiction_geoid", "POST", {
    jurisdiction_geoid: geoid,
    portal_url: candidateUrl,
    vendor_type: vendor,
    submission_method: "online",
    license_required: true,
    notes
  });

  return {
    status: source,
    portal_url: candidateUrl,
    vendor_type: vendor,
    notes
  };
}
