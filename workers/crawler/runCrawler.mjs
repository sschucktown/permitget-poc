import { createClient } from "@supabase/supabase-js";
import { crawlPortalEndpoint } from "./crawlPortal.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

async function run() {
  console.log("🚀 Running Playwright crawler…");

  // Fetch all endpoints not yet crawled
  const { data: endpoints, error } = await supabase
    .from("portal_endpoints")
    .select("*")
    .eq("status", "unknown")
    .limit(10); // Crawl in small chunks per GH Action run

  if (error) {
    console.error(error);
    process.exit(1);
  }

  if (!endpoints.length) {
    console.log("🎉 No endpoints to crawl.");
    return;
  }

  console.log(`📌 Found ${endpoints.length} endpoints`);

  for (const ep of endpoints) {
    await crawlPortalEndpoint(ep);

    // small delay to prevent rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("🎉 Crawler run finished.");
}

run();
