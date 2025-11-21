// workers/runBingSearchBatch.mjs
//
// Production-grade worker for PermitGet using Brave Search API.
// Brave is more stable than SerpAPI on GitHub Actions and always returns JSON.
// Includes retries, safe parsing, and graceful error handling.

import { sb } from "../lib/supabase.js";
import {
  validateURL,
  detectVendor,
  normalizeTylerOAuth,
  checkUrlAlive,
  looksLikePermitPortal
} from "../lib/portalUtils.js";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BATCH_SIZE = parseInt(process.env.BING_BATCH_SIZE || "10", 10);

if (!BRAVE_API_KEY) {
  console.warn("[SearchWorker] WARNING: BRAVE_API_KEY missing in environment");
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
 * Brave Search Core Call (safe + JSON guaranteed)
 * Docs: https://api.search.brave.com/app/documentation/web-search
 * ------------------------------------------------------------- */
async function callBraveSearch(query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query
  )}&count=5`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Subscription-Token": BRAVE_API_KEY,
      Accept: "application/json"
    }
  });

  const text = await res.text();

  if (!text || text.trim().length < 5) {
    throw new Error(`Empty response from Brave Search`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON from Brave for "${query}": ${text.substring(0, 200)}`
    );
  }
}

/* -------------------------------------------------------------
 * Retry wrapper for Brave Search
 * ------------------------------------------------------------- */
async function callSearchWithRetry(query, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await callBraveSearch(query);
    } catch (err) {
      console.warn(
        `[SearchWorker] Brave attempt ${i + 1} failed for "${query}":`,
        err.message
      );

      if (i === attempts - 1) throw err; // Give up

      await new Promise((r) => setTimeout(r, 750)); // backoff
    }
  }
}

/* -------------------------------------------------------------
 * Save best portal info to jurisdiction_meta
 * ------------------------------------------------------------- */
async function upsertJurisdictionMeta(geoid, candidate, jobId) {
  const existing = await sb(
    `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
  );

  const notesBase = candidate
    ? `Seeded from search_queue job ${jobId}`
    : `search_queue job ${jobId}: no reliable portal found`;

  if (existing?.length > 0) {
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
 * Evaluate Brave Search results
 * ------------------------------------------------------------- */
async function handleResults(job, results) {
  let bestCandidate = null;

  for (const r of results) {
    const rawUrl = r.link;
    if (!rawUrl) continue;

    const normalized = normalizeTylerOAuth(rawUrl) || rawUrl;
    const valid = validateURL(normalized);
    if (!valid) continue;

    const alive = await checkUrlAlive(valid);
    if (!alive) continue;

    const looksPortal = await looksLikePermitPortal(valid);
    if (!looksPortal) continue;

    const vendor = detectVendor(valid);

    // Save all candidates
    try {
      await sb("portal_candidates", "POST", {
        jurisdiction_geoid: job.jurisdiction_geoid,
        query_used: job.query,
        url_found: valid,
        vendor_type: vendor,
        confidence: 1.0,
        source: "brave"
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
 * Process one job
 * ------------------------------------------------------------- */
async function processJob(job) {
  await updateJob(job.id, {
    status: "running",
    attempt_count: (job.attempt_count || 0) + 1
  });

  const searchJson = await callSearchWithRetry(job.query);

  const results =
    searchJson?.web?.results && Array.isArray(searchJson.web.results)
      ? searchJson.web.results
      : [];

  const bestCandidate = await handleResults(job, results);

  await upsertJurisdictionMeta(job.jurisdiction_geoid, bestCandidate, job.id);

  await updateJob(job.id, { status: "done", last_error: null });
}

/* -------------------------------------------------------------
 * Run batch
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
    console.error("[SearchWorker] Fatal:", err);
    process.exit(1);
  });
