// workers/reprocessPortals.mjs
// Batch reprocessor to re-run portal discovery for jurisdictions
// and populate jurisdiction_meta for human review / caching.

import { runPortalDiscovery } from "../lib/portalDiscoveryPipeline.js";
import { sb } from "../lib/supabase.js";

const BATCH_SIZE =
  parseInt(process.env.REPROCESS_BATCH_SIZE || "100", 10);
const START_OFFSET =
  parseInt(process.env.REPROCESS_OFFSET || "0", 10);

/**
 * Fetch a batch of jurisdictions.
 * Right now: all jurisdictions, ordered by geoid.
 * You can tighten this later (e.g., only where portal_url is null).
 */
async function fetchJurisdictionsBatch(offset, limit) {
  const path =
    `jurisdictions?select=geoid,name,statefp,portal_url` +
    `&order=geoid.asc` +
    `&limit=${limit}&offset=${offset}`;

  const rows = await sb(path);
  return Array.isArray(rows) ? rows : [];
}

async function processJurisdictionRow(row) {
  const geoid = row.geoid;
  const name = row.name;
  const statefp = row.statefp;

  console.log(`\n──────────────────────────────`);
  console.log(`🏛  ${geoid} – ${name}, ${statefp}`);

  try {
    const result = await runPortalDiscovery({
      geoid,
      forceRefresh: true
    });

    console.log(`   status:       ${result.status}`);
    console.log(`   portal_url:   ${result.portal_url || "(none)"}`);
    console.log(`   vendor_type:  ${result.vendor_type || "unknown"}`);
    console.log(`   notes:        ${result.notes || ""}`);

  } catch (err) {
    console.error(`   ❌ Error for ${geoid}:`, err.message);
  }
}

async function main() {
  console.log("==========================================");
  console.log("🔁 Jurisdiction Portal Reprocessor");
  console.log("==========================================");
  console.log(`Batch size:     ${BATCH_SIZE}`);
  console.log(`Start offset:   ${START_OFFSET}`);
  console.log("==========================================");

  let offset = START_OFFSET;
  let totalProcessed = 0;

  while (true) {
    console.log(`\n📦 Fetching batch at offset ${offset} ...`);

    const batch = await fetchJurisdictionsBatch(offset, BATCH_SIZE);
    if (!batch.length) {
      console.log("✅ No more jurisdictions to process. Exiting.");
      break;
    }

    for (const row of batch) {
      await processJurisdictionRow(row);
      totalProcessed++;
    }

    offset += BATCH_SIZE;

    // Optional: safety break to avoid accidentally running millions
    if (process.env.REPROCESS_MAX &&
        totalProcessed >= parseInt(process.env.REPROCESS_MAX, 10)) {
      console.log(
        `🛑 Hit REPROCESS_MAX=${process.env.REPROCESS_MAX}. Stopping.`
      );
      break;
    }
  }

  console.log("\n==========================================");
  console.log(`🎉 Done. Total jurisdictions processed: ${totalProcessed}`);
  console.log("==========================================");
}

main().catch(err => {
  console.error("Fatal error in reprocessPortals:", err);
  process.exit(1);
});
