// workers/runBingSearchBatch.mjs
//
// Production-grade worker for PermitGet.
// Uses SerpAPI (Google results).
// Includes retries, safe JSON parsing, and graceful error handling.

import { sb } from "../lib/supabase.js";
import {
  validateURL,
  detectVendor,
  normalizeTylerOAuth,
  checkUrlAlive,
  looksLikePermitPortal
} from "../lib/portalUtils.js";

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BATCH_SIZE = parseInt(process.env.BING_BATCH_SIZE || "10", 10);

if (!SERPAPI_KEY) {
  console.warn("[SearchWorker] WARNING: SERPAPI_KEY missing in environment");
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
 * SerpAPI - Safe call + retries + logging
 * ------------------------------------------------------------- */
async function callSerpAPI(query) {
  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", "5");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const res = await fetch(url.toString(), { method: "GET" });

  const text = await res.text();

  if (!text || text.trim().length < 5) {
    throw new Error(`Empty response body from SerpAPI`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON from SerpAPI for query "${query}": ${text.substring(0, 200)}`
    );
  }
}

/* -------------------------------------------------------------
 * Retry wrapper for SerpAPI
 * ------------------------------------------------------------- */
async function callSearchWithRetry(query, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await callSerpAPI(query);
    } catch (err) {
      console.warn(`[SearchWorker] SerpAPI attempt ${i + 1} failed:`, err.message);

      if (i === attempts - 1) throw err;

      await new Promise((r) => setTimeout(r, 500));
    }
  }
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
 * Process search results
 * ------------------------------------------------------------- */
async function handleResults(job, results) {
  let bestCandidate = null;

  for (const r of results) {
    const rawUrl = r.link || r.url;
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
        source: "serpapi"
      });
    } catch {
      console.warn("[SearchWorker] Duplicate candidate ignored");
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

  const searchJson = await callSearchWithRetry(job.query);

  const results =
    Array.isArray(searchJson.organic_results)
      ? searchJson.organic_results
      : [];

  const bestCandidate = await handleResults(job, results);

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

/* -------------------------------------------------------------
 * Execute
 * ------------------------------------------------------------- */
runBatch()
  .then(() => console.log("[SearchWorker] Batch complete"))
  .catch((err) => {
    console.error("[SearchWorker] Fatal error:", err);
    process.exit(1);
  });
