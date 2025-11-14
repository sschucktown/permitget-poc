// api/portal-verifier.js
export const config = {
  runtime: "nodejs"
};

import dns from "node:dns/promises";

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CRON_SECRET = process.env.CRON_SECRET;
const VERIFIER_BATCH = parseInt(process.env.VERIFIER_BATCH || "10", 10);

// ------------------------------------------------------------
// Supabase REST helper
// ------------------------------------------------------------
async function sb(path, method = "GET", body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Supabase Error: ${errorText}`);
  }

  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Utility: does the host resolve?
// ------------------------------------------------------------
async function hostResolves(urlStr) {
  try {
    const u = new URL(urlStr);
    await dns.lookup(u.hostname);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Utility: fetch HTML and scan it
// ------------------------------------------------------------
async function fetchAndAnalyze(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });

    if (!res.ok) {
      return { ok: false, status: res.status, html: "" };
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return { ok: false, status: res.status, html: "" };
    }

    const html = await res.text();
    return { ok: true, html };
  } catch (e) {
    return { ok: false, html: "" };
  }
}

// ------------------------------------------------------------
// Utility: detect vendor from HTML
// ------------------------------------------------------------
function detectVendorFromHTML(html, url) {
  if (!html) return detectVendorFromURL(url);

  const lower = html.toLowerCase();

  const keywords = {
    accela: "accela",
    energov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve",
    tylertech: "tyler",
    mygovernmentonline: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpoint",
    cityview: "cityview"
  };

  for (const key of Object.keys(keywords)) {
    if (lower.includes(key)) return key;
  }

  return detectVendorFromURL(url);
}

// ------------------------------------------------------------
// Fallback vendor detector from just URL
// ------------------------------------------------------------
function detectVendorFromURL(url) {
  if (!url) return "unknown";

  const lower = url.toLowerCase();
  const vendors = {
    accela: "accela",
    energov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve",
    tylertech: "tylertech",
    mygovernmentonline: "mygovernmentonline",
    opengov: "opengov",
    viewpoint: "viewpoint",
    cityview: "cityview"
  };

  for (const [vendor, kw] of Object.entries(vendors)) {
    if (lower.includes(kw)) return vendor;
  }

  if (lower.endsWith(".gov")) return "municipal";

  return "unknown";
}

// ------------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------------
export default async function handler(req, res) {
  try {
    // Secure endpoint
    const auth =
      req.headers["authorization"] ||
      req.headers["Authorization"] ||
      "";

    if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("🔎 Verifier worker started");

    // --------------------------------------------------------
    // 1. Pull unverified batch
    // --------------------------------------------------------
    const rows = await sb(
      `jurisdiction_meta?portal_url=not.is.null&verified.is.false&limit=${VERIFIER_BATCH}`
    );

    if (!rows || rows.length === 0) {
      return res.status(200).json({ status: "idle", scanned: 0 });
    }

    let results = [];

    for (const row of rows) {
      const { jurisdiction_geoid, portal_url, id } = row;
      const result = {
        id,
        geoid: jurisdiction_geoid,
        url: portal_url,
        verified: false,
        reason: ""
      };

      console.log(`➡️  Checking ${jurisdiction_geoid} → ${portal_url}`);

      // ----------------- Step A: DNS Check -------------------
      const resolves = await hostResolves(portal_url);
      if (!resolves) {
        result.reason = "DNS_Failure";
        await markAsInvalid(row);
        results.push(result);
        continue;
      }

      // ----------------- Step B: Fetch Check -----------------
      const fetchResult = await fetchAndAnalyze(portal_url);
      if (!fetchResult.ok) {
        result.reason = "Fetch_Failure";
        await markAsInvalid(row);
        results.push(result);
        continue;
      }

      const html = fetchResult.html.toLowerCase();

      // ----------------- Step C: Keyword Check -----------------
      const required = ["permit", "apply", "contractor", "citizen", "portal"];
      const hits = required.filter(k => html.includes(k));

      if (hits.length === 0) {
        result.reason = "No_Portal_Keywords";
        await markAsInvalid(row);
        results.push(result);
        continue;
      }

      // ----------------- Step D: Vendor Check -----------------
      const vendor = detectVendorFromHTML(html, portal_url);

      // ----------------- Step E: Store Verified ----------------
      await sb(`jurisdiction_meta?id=eq.${id}`, "PATCH", {
        verified: true,
        verified_at: new Date().toISOString(),
        vendor_type: vendor,
        verification_html_sample: html.slice(0, 2000) // small snippet
      });

      result.verified = true;
      result.reason = "OK";
      results.push(result);
    }

    return res.status(200).json({
      status: "completed",
      scanned: results.length,
      results
    });

  } catch (err) {
    console.error("🔥 Verifier Error:", err);
    return res.status(500).json({
      error: "Internal error",
      message: err.message
    });
  }
}

// ------------------------------------------------------------
// Mark invalid + requeue for AI
// ------------------------------------------------------------
async function markAsInvalid(row) {
  const { id, jurisdiction_geoid } = row;

  // Update meta
  await sb(`jurisdiction_meta?id=eq.${id}`, "PATCH", {
    verified: false,
    invalid: true,
    invalid_at: new Date().toISOString()
  });

  // Requeue in discovery jobs table
  await sb("portal_discovery_jobs", "POST", {
    jurisdiction_geoid,
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString()
  });
}
