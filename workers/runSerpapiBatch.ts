// workers/runSerpapiBatch.ts
import fetch from "node-fetch";

export async function runSerpapiBatch(limit = 5) {
  const { data: jobs, error } = await supabase
    .from("search_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  if (!jobs?.length) return 0;

  for (const job of jobs) {
    await supabase.from("search_queue").update({ status: "running" }).eq("id", job.id);

    try {
      const res = await fetch(
        `https://serpapi.com/search.json?q=${encodeURIComponent(job.query)}&engine=google&api_key=${process.env.SERPAPI_KEY}`
      );
      const serp = await res.json();

      const candidates =
        serp.organic_results?.map((r: any, idx: number) => ({
          jurisdiction_geoid: job.jurisdiction_geoid,
          query_used: job.query,
          url_found: r.link,
          title: r.title,
          snippet: r.snippet,
          serp_position: idx + 1,
          serpapi_json: r
        })) ?? [];

      if (candidates.length) {
        await supabase.from("portal_candidates").insert(candidates);
      }

      await supabase.from("search_queue").update({ status: "done" }).eq("id", job.id);
    } catch (e: any) {
      await supabase
        .from("search_queue")
        .update({
          status: "error",
          last_error: e.message,
          attempt_count: job.attempt_count + 1
        })
        .eq("id", job.id);
    }
  }

  return jobs.length;
}
