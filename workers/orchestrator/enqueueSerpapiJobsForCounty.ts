// workers/orchestrator/enqueueSerpapiJobsForCounty.ts

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

export async function enqueueSerpapiJobsForCounty(countyGeoid: string) {
  const baseQueries = [
    "building permits",
    "building permit portal",
    "online permitting",
    "permit portal",
    "building permits Accela",
    "building permits EnerGov",
    "building permits Tyler",
    "eTRAKiT",
    "Cloudpermit",
    "permit application pdf",
    "permit application form",
    "building permits fee schedule",
  ];

  // fetch county + places
  const { data: jurisdictions, error } = await supabase
    .from("jurisdictions")
    .select("geoid, name, level")
    .or(`geoid.eq.${countyGeoid},county_geoid.eq.${countyGeoid}`);

  if (error) throw error;

  const rows = jurisdictions.flatMap((j) =>
    baseQueries.map((q) => ({
      jurisdiction_geoid: j.geoid,
      jurisdiction_name: j.name,
      jurisdiction_type: j.level,
      query: `"${j.name}" SC ${q}`, // << UPDATED (added quotes)
      status: "pending",
    }))
  );

  const { error: insertError } = await supabase
    .from("search_queue")
    .insert(rows);

  if (insertError) throw insertError;

  await supabase
    .from("jurisdiction_mapping_status")
    .upsert({
      jurisdiction_geoid: countyGeoid,
      mapping_status: "discovered",
      last_step: "enqueueSerpapiJobsForCounty",
    });

  return rows.length;
}
