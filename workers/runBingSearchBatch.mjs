// workers/runBingSearchBatch.mjs
//
// PermitGet hybrid search worker.
// 1) Primary: DuckDuckGo HTML (no key, super stable)
// 2) Fallback: Tavily API (semantic, structured JSON)
// No direct provider .json() calls that can blow up unexpectedly.
//
// Env vars used:
//   BING_BATCH_SIZE      - batch size (reuse existing env)
//   TAVILY_API_KEY       - optional, for fallback
//   SUPABASE_URL         - for sb()
//   SUPABASE_SERVICE_ROLE- for sb()

import { sb } from "../lib/supabase.js";
import {
  validateURL,
  detectVendor,
  normalizeTylerOAuth,
  checkUrlAlive,
  looksLikePermitPortal
} from "../lib/portalUtils.js";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const BATCH_SIZE = parseInt(process.env.BING_BATCH_SIZE || "10", 10);

if (!TAVILY_API_KEY) {
  console.warn("[SearchWorker] NOTE: TAVILY_API_KEY missing. Only DuckDuckGo will be used.");
}

/* -------------------------------------------------------------
 * Fetch pending jobs
 * ------------------------------------------------------------- */
async function fetchPendingJobs(limit) {
  const path =
    `search_queue?status=eq.pending` +
    `&order=created_at.asc` +
    `&limit=${limit}`;

  const rows = await sb(path);
  return Array.isArray(rows) ? rows : [];
}

/* -------------------------------------------------------------
 * Update job status
 * ------------------------------------------------------------- */
async function updateJob(id, fields) {
  const path = `search_queue?id=eq.${id}`;
  await sb(path, "PATCH", {
    ...fields,
    updated_at: new Date().toISOString()
  });
}

/* -------------------------------------------------------------
 * DuckDuckGo HTML search (primary)
 * ------------------------------------------------------------- */
async function ddgSearch(query, maxResults = 5) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&num=${maxResults}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; PermitGetBot/1.0; +https://permitget.com/bot)",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const html = await res.text();
  if (!html || html.trim().length < 10) {
    throw new Error("DDG: empty or too-short HTML response");
  }

  const results = [];
  const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g;
  let match;

  while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const href = match[1];

    let targetUrl = null;

    if (href.startsWith("https://duckduckgo.com/l/?uddg=") || href.startsWith("/l/?uddg=")) {
      const idx = href.indexOf("uddg=");
      if (idx !== -1) {
        const after = href.substring(idx + 5);
        const ampIdx = after.indexOf("&");
        const encoded = ampIdx === -1 ? after : after.substring(0, ampIdx);
        try {
          targetUrl = decodeURIComponent(encoded);
        } catch {
          targetUrl = null;
        }
      }
    } else if (href.startsWith("http://") || href.startsWith("https://")) {
      targetUrl = href;
    }

    if (targetUrl) {
      results.push({ url: targetUrl });
    }
  }

  return results;
}

/* -------------------------------------------------------------
 * Tavily search (fallback)
 * ------------------------------------------------------------- */
async function tavilySearch(query, maxResults = 5) {
  if (!TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY not set");
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_images: false,
      include_raw_content: false
    })
  });

  const text = await res.text();
  if (!text || text.trim().length < 5) {
    throw new Error("Tavily: empty or too-short response body");
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Tavily: invalid JSON for "${query}": ${text.substring(0, 200)}`
    );
  }

  const results = Array.isArray(json.results) ? json.results : [];
  return results
    .map(r => r.url)
    .filter(u => typeof u === "string" && u.startsWith("http"))
    .slice(0, maxResults)
    .map(url => ({ url }));
}

/* -------------------------------------------------------------
 * Hybrid search: DDG primary, Tavily fallback
 * ------------------------------------------------------------- */
async function hybridSearch(query) {
  // 1) Try DuckDuckGo first
  try {
    const ddgResults = await ddgSearch(query, 5);
    if (ddgResults.length > 0) {
      return ddgResults;
    }
  } catch (err) {
    console.warn("[SearchWorker] DDG search failed:", err.message);
  }

  // 2) Fallback to Tavily, if available
  if (TAVILY_API_KEY) {
    try {
      const tavilyResults = await tavilySearch(query, 5);
      if (tavilyResults.length > 0) {
        return tavilyResults;
      }
    } catch (err) {
      console.warn("[SearchWorker] Tavily search failed:", err.message);
    }
  }

  // 3) If everything fails, return empty list
  return [];
}

/* -------------------------------------------------------------
 * Upsert jurisdiction metadata
 * ------------------------------------------------------------- */
async function upsertJurisdictionMeta(geoid, candidate, jobId) {
  const existing = await sb(
    `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
  );

  const notesBase = candidate
    ? `Seeded from search_queue job ${jobId}`
    : `search_queue job ${jobId}: no reliable portal found`;

  if (Array.isArray(existing) && existing.length > 0) {
    const meta = existing[0];

    await sb(`jurisdiction_meta?id=eq.${meta.id}`, "PATCH", {
      portal_url: candidate ? candidate.url : meta.portal_url,
      vendor_type: candidate ? candidate.vendor : meta.vendor_type,
      submission_method:
        candidate && candidate.url ? "online" : meta.submission_method || "unknown",
      license_required:
        candidate && candidate.url ? true : meta.license_required,
      notes: meta.notes ? `${meta.notes}\n${notesBase}` : notesBase
    });
  } else {
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: candidate ? candidate.url : null,
      vendor_type: candidate ? candidate.vendor : "unknown",
      submission_method:
        candidate && candidate.url ? "online" : "unknown",
      license_required: candidate && candidate.url ? true : null,
      notes: notesBase
    });
  }
}

/* -------------------------------------------------------------
 * Process results for a single job
 * ------------------------------------------------------------- */
async function handleResults(job, results) {
  let bestCandidate = null;

  for (const r of results) {
    const rawUrl = r.url || r.link;
    if (!rawUrl) continue;

    const normalized = normalizeTylerOAuth(rawUrl) || rawUrl;
    const valid = validateURL(normalized);
    if (!valid) continue;

    const alive = await checkUrlAlive(valid);
    if (!alive) continue;

    const looksPortal = await looksLikePermitPortal(valid);
    if (!looksPortal) continue;

    const vendor = detectVendor(valid);

    try {
      await sb("portal_candidates", "POST", {
        jurisdiction_geoid: job.jurisdiction_geoid,
        query_used: job.query,
        url_found: valid,
        vendor_type: vendor,
        confidence: 1.0,
        source: "ddg+tavily"
      });
    } catch {
      console.warn("[SearchWorker] Duplicate portal_candidate ignored");
    }

    if (!bestCandidate) {
      bestCandidate = { url: valid, vendor, confidence: 1.0 };
    }
  }

  return bestCandidate;
}

/* -------------------------------------------------------------
 * Process a single job
 * ------------------------------------------------------------- */
async function processJob(job) {
  await updateJob(job.id, {
    status: "running",
    attempt_count: (job.attempt_count || 0) + 1
  });

  const searchResults = await hybridSearch(job.query);

  const bestCandidate = await handleResults(job, searchResults);

  await upsertJurisdictionMeta(job.jurisdiction_geoid, bestCandidate, job.id);

  await updateJob(job.id, { status: "done", last_error: null });
}

/* -------------------------------------------------------------
 * Batch runner
 * ------------------------------------------------------------- */
async function runBatch() {
  const jobs = await fetchPendingJobs(BATCH_SIZE);

  if (!jobs.length) {
    console.log("[SearchWorker] No pending jobs.");
    return;
  }

  for (const job of jobs) {
    console.log(
      `\n[SearchWorker] Processing job ${job.id} (${job.jurisdiction_type} ${job.jurisdiction_geoid})`
    );

    try {
      await processJob(job);
    } catch (err) {
      console.error("[SearchWorker] Error on job", job.id, err.message);
      await updateJob(job.id, {
        status: "error",
        last_error: err.message
      });
    }
  }
}

runBatch()
  .then(() => console.log("[SearchWorker] Batch complete"))
  .catch((err) => {
    console.error("[SearchWorker] Fatal error:", err);
    process.exit(1);
  });
