import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

export async function detectPortalsForCounty(countyGeoid) {
  console.log(`🔎 Detecting portals for ${countyGeoid}`);

  // 1. Fetch county + all municipalities
  const { data: jurisdictions, error: jErr } = await supabase
    .from("jurisdictions")
    .select("geoid, name")
    .or(`geoid.eq.${countyGeoid},county_geoid.eq.${countyGeoid}`);

  if (jErr) {
    console.error(jErr);
    return;
  }

  const geoids = jurisdictions.map((j) => j.geoid);

  // 2. Fetch all portal candidates for this county
  const { data: candidates, error: cErr } = await supabase
    .from("portal_candidates")
    .select("id, jurisdiction_geoid, url_found")
    .in("jurisdiction_geoid", geoids);

  if (cErr) {
    console.error(cErr);
    return;
  }

  const portalRows = [];

  for (const c of candidates) {
    const url = (c.url_found || "").toLowerCase();

    let vendor = null;

    if (url.includes("citizenaccess") || url.includes("aca")) vendor = "accela";
    else if (url.includes("energov") || url.includes("selfservice")) vendor = "energov";
    else if (url.includes("tyler")) vendor = "tyler";
    else if (url.includes("etrakit")) vendor = "etrakit";
    else if (url.includes("cloudpermit")) vendor = "cloudpermit";
    else if (url.endsWith(".pdf")) vendor = "pdf";
    else if (url.includes(".gov") || url.includes(".us")) vendor = "gov_page";
    else vendor = "unknown";

    // only keep meaningful portal vendors
    if (vendor !== "unknown") {
      portalRows.push({
        jurisdiction_geoid: c.jurisdiction_geoid,
        url: c.url_found,
        vendor,
        status: "unknown",
      });
    }
  }

  if (portalRows.length > 0) {
    const { error: insertErr } = await supabase
      .from("portal_endpoints")
      .insert(portalRows)
      .onConflict("jurisdiction_geoid, url")
      .ignore();

    if (insertErr) {
      console.error(insertErr);
    }
  }

  console.log(`✅ Found ${portalRows.length} portal endpoints`);

  return portalRows.length;
}
