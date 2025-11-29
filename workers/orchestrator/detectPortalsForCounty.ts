// workers/orchestrator/detectPortalsForCounty.ts
export async function detectPortalsForCounty(countyGeoid: string) {
  const { data: candidates, error } = await supabase
    .from("portal_candidates")
    .select("*")
    .in(
      "jurisdiction_geoid",
      (await supabase
        .from("jurisdictions")
        .select("geoid")
        .or(`geoid.eq.${countyGeoid},county_geoid.eq.${countyGeoid}`)).data?.map(j => j.geoid) ?? []
    );

  if (error) throw error;

  const portalRows: any[] = [];

  for (const c of candidates) {
    const url = (c.url_found || "").toLowerCase();
    let vendor: string | null = null;

    if (url.includes("citizenaccess") || url.includes("aca")) vendor = "accela";
    else if (url.includes("energov") || url.includes("selfservice")) vendor = "energov";
    else if (url.includes("tyler")) vendor = "tyler";
    else if (url.includes("etrakit")) vendor = "etrakit";
    else if (url.includes("cloudpermit")) vendor = "cloudpermit";

    // only treat obvious vendor portals & non-PDFs as primary candidates
    const isPdf = url.endsWith(".pdf");

    if (vendor && !isPdf) {
      portalRows.push({
        jurisdiction_geoid: c.jurisdiction_geoid,
        url: c.url_found,
        vendor,
        status: "unknown"
      });
    }
  }

  if (portalRows.length) {
    await supabase
      .from("portal_endpoints")
      .insert(portalRows)
      .onConflict("jurisdiction_geoid, url")
      .ignore();
  }

  return portalRows.length;
}
