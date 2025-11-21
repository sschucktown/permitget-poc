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

  // Reject empty bodies
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

      // Last attempt → throw error
      if (i === attempts - 1) throw err;

      // Backoff 0.5s
      await new Promise((r) => setTimeout(r, 500));
    }
