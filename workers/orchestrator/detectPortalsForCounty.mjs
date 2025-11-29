// workers/orchestrator/detectPortalsForCounty.mjs

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: { persistSession: false },
  }
);

export async function detectPortalsForCounty(countyGeoid) {
  console.log(`🔎 Detecting portal endpoints for ${countyGeoid}`);

  //
  // 1️⃣ Load the county + all municipalities beneath it
  //
  const { data: jurisdictions, error: jErr } = await supabase
    .from("jurisdictions")
    .select("geoid, name")
    .or(`geoid.eq.${countyGeoid},county_geoid.eq.${countyGeoid}`);

  if (jErr) {
    console.error("❌ Failed loading jurisdictions:", jErr);
    throw jErr;
  }

  const geoids = jurisdictions.map((j) => j.geoid);

  console.log(`📌 Loaded ${geoids.length} jurisdictions`);

  //
  // 2️⃣ Load all portal candidates for these jurisdictions
  //
  const { data: candidates, error: cErr } = await supabase
    .from("portal_candidates")
    .select("id, jurisdiction_geoid, url_found")
    .in("jurisdiction_geoid", geoids);

  if (cErr) {
    console.error("❌ Failed loading portal candidates:", cErr);
    throw cErr;
  }

  console.log(`📌 Loaded ${candidates.length} raw portal candidates`);

  //
  // 3️⃣ Determine vendor type from the URL
  //
  const portalRows = [];

  for (const c of candidates) {
    const url = (c.url_found || "").toLowerCase();
    let vendor = "unknown";

    if (url.includes("citizenaccess") || url.includes("aca")) vendor = "accela";
    else if (url.includes("energov") || url.includes("selfservice")) vendor = "energov";
    else if (url.includes("tyler")) vendor = "tyler";
    else if (url.includes("etrakit")) vendor = "etrakit";
    else if (url.includes("cloudpermit")) vendor = "cloudpermit";
    else if (url.endsWith(".pdf")) vendor = "pdf";
    else if (url.includes(".gov") || url.includes(".us")) vendor = "gov_page";

    // Keep only relevant endpoints
    if (vendor !== "unknown") {
      portalRows.push({
        jurisdiction_geoid: c.jurisdiction_geoid,
        url: c.url_found,
        vendor,
        status: "unknown", // Will be updated after crawling
      });
    }
  }

  console.log(`📌 Classified ${portalRows.length} portal endpoints`);

  //
  // 4️⃣ Insert into portal_endpoints using upsert (Supabase v2)
  //
  if (portalRows.length > 0) {
    const { error: upsertErr } = await supabase
      .from("portal_endpoints")
      .upsert(portalRows, {
        onConflict: "jurisdiction_geoid,url",
        ignoreDuplicates: true,
      });

    if (upsertErr) {
      console.error("❌ Upsert error:", upsertErr);
      throw upsertErr;
    }
  }

  console.log(`✅ Portal detection finished for ${countyGeoid}`);
  return portalRows.length;
}
