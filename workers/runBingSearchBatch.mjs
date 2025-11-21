// workers/runBingSearchBatch.mjs
//
// Uses SerpAPI (Google results) instead of Bing Web Search.
// Expects SERPAPI_KEY env var.

import { sb } from "../lib/supabase.js";
import {
  validateURL,
  detectVendor,
  normalizeTylerOAuth,
  checkUrlAlive,
  looksLikePermitPortal
} from "../lib/portalUtils.js";

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BATCH_SIZE = parseInt(process.env.BING_BATCH_SIZE || "10", 10); // reuse existing env name

if (!SERPAPI_KEY) {
  console.warn("[SearchWorker] Missing SERPAPI_KEY");
}

async function fetchPendingJobs(limit) {
  const path =
    `search_queue?status=eq.pending` +
    `&order=created_at.asc` +
    `&limit=${limit}`;

  const rows = await sb(path);
  return Array.isArray(rows) ? rows : [];
}

async function updateJob(id, fields) {
  const path = `search_queue?id=eq.${id}`;
  await sb(path, "PATCH", {
    ...fields,
    updated_at: new Date().toISOString()
  });
}

/**
 * Call SerpAPI (Google Search).
 * Docs: https://serpapi.com/search-api
 */
async function callSearch(query) {
  if (!SERPAPI_KEY) {
    throw new Error("SERPAPI_KEY is not set");
  }

  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", "5");      // number of results
  url.searchParams.set("hl", "en");      // language
  url.searchParams.set("gl", "us");      // country
  url.searchParams.set("api_key", SERPAPI_KEY);

  const res = await fetch(url.toString(), {
    method: "GET"
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Search error ${res.status}: ${text}`);
  }

  return res.json();
}

async function upsertJurisdictionMeta(geoid, candidate, jobId) {
  const existing = await sb(
    `jurisdiction_meta?jurisdiction_geoid=eq.${geoid}&limit=1`
  );

  const notesBase = candidate
    ? `Seeded from search_queue job ${jobId}`
    : `search_queue job ${jobId}: no reliable portal found`;

  if (Array.isArray(existing) && existing.length > 0) {
    const meta = existing[0];
    const path = `jurisdiction_meta?id=eq.${meta.id}`;

    await sb(path, "PATCH", {
      portal_url: candidate ? candidate.url : meta.portal_url,
      vendor_type: candidate ? candidate.vendor : meta.vendor_type,
      submission_method:
        candidate && candidate.url
          ? "online"
          : meta.submission_method || "unknown",
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

async function handleResults(job, results) {
  let bestCandidate = null;

  for (const r of results) {
    // SerpAPI uses "link" for the URL; fall back to "url" if present.
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
    const confidence = 1.0;

    try {
      await sb("portal_candidates", "POST", {
        jurisdiction_geoid: job.jurisdiction_geoid,
        query_used: job.query,
        url_found: valid,
        vendor_type: vendor,
        confidence,
        source: "serpapi"
      });
    } catch (e) {
      console.warn(
        "[SearchWorker] portal_candidates insert error (probably duplicate):",
        e.message
      );
    }

    if (!bestCandidate) {
      bestCandidate = { url: valid, vendor, confidence };
    }
  }

  return bestCandidate;
}

async function processJob(job) {
  await updateJob(job.id, {
    status: "running",
    attempt_count: (job.attempt_count || 0) + 1
  });

  const searchJson = await callSearch(job.query);

  // SerpAPI Google engine: main results live in "organic_results".
  const results =
    (Array.isArray(searchJson.organic_results)
      ? searchJson.organic_results
      : []) || [];

  const bestCandidate = await handleResults(job, results);
  await upsertJurisdictionMeta(job.jurisdiction_geoid, bestCandidate, job.id);

  await updateJob(job.id, { status: "done", last_error: null });
}

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
      console.error("[SearchWorker] Error on job", job.id, err);
      await updateJob(job.id, {
        status: "error",
        last_error: err.message || String(err)
      });
    }
  }
}

runBatch()
  .then(() => {
    console.log("[SearchWorker] Batch complete.");
  })
  .catch(err => {
    console.error("[SearchWorker] Fatal error:", err);
    process.exit(1);
  });
