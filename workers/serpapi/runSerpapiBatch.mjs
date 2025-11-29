// workers/serpapi/runSerpapiBatch.mjs

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: { persistSession: false }
  }
);

async function runBatch() {
  console.log("🔎 Starting SerpAPI batch...");

  // 1. Get pending jobs
  const { data: jobs, error } = await supabase
    .from("search_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);

  if (error) {
    console.error("❌ Error fetching jobs:", error);
    process.exit(1);
  }

  if (!jobs || jobs.length === 0) {
    console.log("⚠️ No pending SerpAPI jobs.");
    return;
  }

  console.log(`📌 Found ${jobs.length} job(s). Running...`);

  for (const job of jobs) {
    console.log(`➡️ Running: ${job.query}`);

    // Mark running
    await supabase
      .from("search_queue")
      .update({ status: "running" })
      .eq("id", job.id);

    try {
      // Call SerpAPI
      const serpRes = await fetch(
        `https://serpapi.com/search.json?q=${encodeURIComponent(
          job.query
        )}&engine=google&api_key=${process.env.SERPAPI_KEY}`
      );

      const serp = await serpRes.json();

      const results = serp.organic_results || [];

      const insertRows = results.map((r, i) => ({
        jurisdiction_geoid: job.jurisdiction_geoid,
        query_used: job.query,
        url_found: r.link,
        title: r.title,
        snippet: r.snippet,
        serp_position: i + 1,
        serpapi_json: r
      }));

      if (insertRows.length > 0) {
        const { error: insertErr } = await supabase
          .from("portal_candidates")
          .insert(insertRows);

        if (insertErr) console.error("❌ Insert error:", insertErr);
      }

      // Mark success
      await supabase
        .from("search_queue")
        .update({ status: "done" })
        .eq("id", job.id);

      console.log(`✅ Done: ${job.query}`);

    } catch (err) {
      console.error("❌ SerpAPI error:", err);

      await supabase
        .from("search_queue")
        .update({
          status: "error",
          last_error: err.toString(),
          attempt_count: job.attempt_count + 1
        })
        .eq("id", job.id);
    }
  }

  console.log("🎉 SerpAPI batch complete.");
}

runBatch();
