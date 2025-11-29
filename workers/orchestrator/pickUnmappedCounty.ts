// workers/orchestrator/pickUnmappedCounty.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);

export async function pickUnmappedCounty() {
  const { data, error } = await supabase
    .from("jurisdictions")
    .select("geoid, name")
    .eq("level", "county")
    .order("geoid", { ascending: true });

  if (error) throw error;

  // join with mapping status, pick first not_started
  const { data: statusData, error: statusError } = await supabase
    .from("jurisdiction_mapping_status")
    .select("jurisdiction_geoid, mapping_status");

  if (statusError) throw statusError;

  const statusMap = new Map(statusData?.map(r => [r.jurisdiction_geoid, r.mapping_status]));

  const candidate = data?.find(c => !statusMap.get(c.geoid) || statusMap.get(c.geoid) === "not_started");

  if (!candidate) return null;

  await supabase
    .from("jurisdiction_mapping_status")
    .upsert({
      jurisdiction_geoid: candidate.geoid,
      mapping_status: "discovery_pending",
      last_step: "pickUnmappedCounty"
    });

  return candidate; // { geoid, name }
}
