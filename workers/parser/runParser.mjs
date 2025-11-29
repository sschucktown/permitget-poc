import { createClient } from "@supabase/supabase-js";
import { parseSnapshot } from "./gptParser.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

async function run() {
  console.log("🚀 Running GPT Parser…");

  const { data: snapshots, error } = await supabase
    .from("portal_snapshots")
    .select("*")
    .is("parsed", null)
    .order("created_at", { ascending: true })
    .limit(3);

  if (error) {
    console.error("❌ Snapshot query error:", error);
    process.exit(1);
  }

  if (!snapshots.length) {
    console.log("🎉 No unparsed snapshots!");
    return;
  }

  for (const snap of snapshots) {
    await parseSnapshot(snap);

    // Gentle delay for GPT rate limits
    await new Promise((r) => setTimeout(r, 800));
  }

  console.log("🎉 GPT parser run finished.");
}

run();
