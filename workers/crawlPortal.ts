// workers/crawlPortal.ts
import { chromium } from "playwright";

export async function crawlPortal(portalId: number) {
  const { data: portal, error } = await supabase
    .from("portal_endpoints")
    .select("*")
    .eq("id", portalId)
    .single();
  if (error || !portal) throw error || new Error("Portal not found");

  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(portal.url, { waitUntil: "networkidle" });

  // For v1: just grab HTML.
  const html = await page.content();
  await browser.close();

  // Store HTML snapshot in Supabase storage, then insert portal_snapshots
  const path = `portal_html/${portal.id}/${Date.now()}.html`;
  await supabase.storage.from("crawler").upload(path, Buffer.from(html), {
    contentType: "text/html"
  });

  const rawHash = createHash("sha256").update(html).digest("hex");

  const { data: snapshot, error: snapError } = await supabase
    .from("portal_snapshots")
    .insert({
      portal_id: portal.id,
      snapshot_type: "html",
      storage_path: path,
      raw_hash: rawHash
    })
    .select("*")
    .single();

  if (snapError) throw snapError;

  return snapshot;
}
