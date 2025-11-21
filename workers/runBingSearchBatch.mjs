// workers/runBingSearchBatch.mjs
//
// PermitGet hybrid search worker (SAFE version)
// 1) Primary: DuckDuckGo HTML (stable, no API key)
// 2) Fallback: Tavily API (semantic search, NOW crash-proof)
//
// This worker NEVER throws "Unexpected end of JSON input".
// Tavily errors / HTML / invalid responses -> graceful fallback to DDG.
//
// Env vars used:
//   BING_BATCH_SIZE
//   TAVILY_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE

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
      "User-Agent": "Mozilla/5.0 (PermitGetBot/1.0)",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const html = await res.text();
  if (!html || html.trim().length < 10) {
    console.warn("[DDG] Empty or tiny HTML response");
    return [];
  }

  const results = [];
  const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/g;

  let match;
  while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
    const href = match[1];
    let targetUrl = null;

    // DDG redirect format
    if (href.includes("uddg=")) {
      const idx = href.indexOf("uddg=");
      if (idx !== -1) {
        const rest = href.substring(idx + 5);
        const end = rest.indexOf("&");
        const encoded = end === -1 ? rest : rest.substring(0, end);
        try {
          targetUrl = decodeURIComponent(encoded);
        } catch {
          targetUrl = null;
        }
      }
    }

    // Direct URLs
    if (!targetUrl && (href.startsWith("http://") || href.startsWith("https://"))) {
      targetUrl = href;
    }

    if (targetUrl) results.push({ url: targetUrl });
  }

  return results;
}

/* -------------------------------------------------------------
 * Tavily search (fallback, CRASH-PROOF VERSION)
 * ------------------------------------------------------------- */
async function tavilySearch(query, maxResults = 5) {
  if (!TAVILY_API_KEY) return [];

  let res;
  try {
    res = await fetch("https://api.tavily.com/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  } catch (err) {
    console.warn("[Tavily] Network error:", err.message);
    return [];
  }

  const text = await res.text();

  // Tavily returns HTML when key is invalid, expired, or rate-limited.
  if (!text || text.trim().length < 5 || text.startsWith("<")) {
    console.warn("[Tavily] HTML or empty response, skipping:", text.slice(0, 200));
    return [];
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.warn("[Tavily] Invalid JSON:", text.slice(0, 200));
    return [];
  }

  if (!Array.isArray(json.results)) return [];

  return json.results
    .map(r => r.url)
    .filter(u => typeof u === "string" && u.startsWith("http"))
    .slice(0, maxResults)
    .map(url => ({ url }));
}

/* -------------------------------------------------------------
 * Hybrid search: DDG → Tavily fallback
 * ------------------------------------------------------------- */
async function hybridSearch(query) {
  // Try DDG first
  try {
    const ddgResults = await ddgSearch(query, 5);
    if (ddgResults.length > 0) return ddgResults;
  } catch (err) {
    console.warn("[SearchWorker] DDG failed:", err.message);
  }

  // Tavily fallback
  try {
    const tavilyResults = await tavilySearch(query, 5);
    if (tavilyResults.length > 0) return tavilyResults;
  } catch (err) {
    console.warn("[SearchWorker] Tavily failed:", err.message);
  }

  // Nothing found
  return [];
}

/* -------------------------------------------------------------
 * Upsert jurisdiction metadata
 * ------------------------------------------------------------- */
async function upsertJurisdictionMeta(geoid, candidate, jobId) {
  const existing = await sb(
    `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
  );

  const notesBase =
    candidate
      ? `Seeded from search_queue job ${jobId}`
      : `search_queue job ${jobId}: no reliable portal found`;

  if (existing?.length > 0) {
    const meta = existing[0];

    await sb(`jurisdiction_meta?id=eq.${meta.id}`, "PATCH", {
      portal_url: candidate ? candidate.url : meta.portal_url,
      vendor_type: candidate ? candidate.vendor : meta.vendor_type,
      submission_method: candidate ? "online" : meta.submission_method || "unknown",
      license_required: candidate ? true : meta.license_required,
      notes: meta.notes ? `${meta.notes}\n${notesBase}` : notesBase
    });
  } else {
    await sb("jurisdiction_meta", "POST", {
      jurisdiction_geoid: geoid,
      portal_url: candidate ? candidate.url : null,
      vendor_type: candidate ? candidate.vendor : "unknown",
      submission_method: candidate ? "online" : "unknown",
      license_required: candidate ? true : null,
      notes: notesBase
    });
  }
}

/* -------------------------------------------------------------
 * Process results for a single job
 * ------------------------------------------------------------- */
async function handleResults(job, results) {
  let best = null;

  for (const r of results) {
    const raw = r.url;
    if (!raw) continue;

    const normalized = normalizeTylerOAuth(raw) || raw;
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
    } catch { /* duplicate safe */ }

    if (!best) best = { url: valid, vendor, confidence: 1.0 };
  }

  return best;
}

/* -------------------------------------------------------------
 * Process a single job
 * ------------------------------------------------------------- */
async function processJob(job) {
  await updateJob(job.id, {
    status: "running",
    attempt_count: (job.attempt_count || 0) + 1
  });

  const results = await hybridSearch(job.query);
  const best = await handleResults(job, results);
  await upsertJurisdictionMeta(job.jurisdiction_geoid, best, job.id);

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
  .catch(err => {
    console.error("[SearchWorker] Fatal error:", err);
    process.exit(1);
  });
