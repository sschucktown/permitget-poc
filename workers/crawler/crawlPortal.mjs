import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import crypto from "crypto";

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: { persistSession: false },
  }
);

// Helper: compute SHA-256
function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Helper: delay (good for throttling)
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------
// VENDOR-SPECIFIC CRAWLING
// ------------------------------

async function crawlAccela(page, url) {
  console.log("🌐 Crawling Accela portal…");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  // Avoid heavy JavaScript logins
  await page.waitForTimeout(1000);

  return await page.content();
}

async function crawlEnerGov(page, url) {
  console.log("🌐 Crawling EnerGov / Tyler SelfService…");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1000);

  return await page.content();
}

async function crawlETRAKIT(page, url) {
  console.log("🌐 Crawling eTRAKiT portal…");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1000);

  return await page.content();
}

async function crawlPDF(url) {
  console.log("📄 Fetching PDF…");

  const res = await fetch(url);
  const array = await res.arrayBuffer();
  const buf = Buffer.from(array);

  const hash = sha256(buf);
  const filename = `pdfs/${hash}.pdf`;

  await supabase.storage
    .from("portal_snapshots")
    .upload(filename, buf, { contentType: "application/pdf", upsert: false })
    .catch((e) => {
      console.error("❌ PDF upload failed:", e);
    });

  return { html: null, pdfHash: hash };
}

async function crawlGeneric(page, url) {
  console.log("🌐 Crawling generic gov page…");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(1000);

  return await page.content();
}

// ------------------------------
// MAIN CRAWLER
// ------------------------------

export async function crawlPortalEndpoint(endpointRow) {
  const { id, url, vendor, jurisdiction_geoid } = endpointRow;

  console.log(`\n🚀 Crawling: ${url}`);
  console.log(`Vendor: ${vendor}`);

  // Handle PDFs separately
  if (vendor === "pdf") {
    const { pdfHash } = await crawlPDF(url);

    await supabase.from("portal_endpoints").update({
      status: "crawled",
      last_error: null,
    }).eq("id", id);

    await supabase.from("portal_snapshots").insert({
      jurisdiction_geoid,
      url,
      vendor,
      hash: pdfHash,
      snapshot_url: `pdfs/${pdfHash}.pdf`,
      created_at: new Date().toISOString()
    });

    console.log("📄 PDF snapshot stored.");
    return;
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  let html = null;

  try {
    if (vendor === "accela") {
      html = await crawlAccela(page, url);
    } else if (vendor === "energov" || vendor === "tyler") {
      html = await crawlEnerGov(page, url);
    } else if (vendor === "etrakit") {
      html = await crawlETRAKIT(page, url);
    } else if (vendor === "gov_page" || vendor === "cloudpermit") {
      html = await crawlGeneric(page, url);
    } else {
      console.log("⚠️ Unknown vendor type — skipping");
      return;
    }

    const hash = sha256(html);
    const filename = `html/${hash}.html`;

    const uploadRes = await supabase.storage
      .from("portal_snapshots")
      .upload(filename, Buffer.from(html), {
        contentType: "text/html",
        upsert: false,
      });

    if (uploadRes.error) throw uploadRes.error;

    // Insert metadata
    await supabase.from("portal_snapshots").insert({
      jurisdiction_geoid,
      url,
      vendor,
      hash,
      snapshot_url: filename,
      created_at: new Date().toISOString(),
    });

    console.log(`✅ Snapshot stored: ${filename}`);

    // Mark endpoint as crawled
    await supabase
      .from("portal_endpoints")
      .update({ status: "crawled", last_error: null })
      .eq("id", id);

  } catch (err) {
    console.error("❌ Crawl error:", err);

    await supabase
      .from("portal_endpoints")
      .update({
        status: "error",
        last_error: err.toString(),
      })
      .eq("id", id);
  } finally {
    await browser.close();
  }
}
