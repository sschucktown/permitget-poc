// lib/portalUtils.js
//
// NOTE:
// Node 18+ includes global fetch. No need for node-fetch.
// This file is ESM-safe and works in Vercel serverless + Node environments.
//

/**
 * Validate a candidate URL as a possible online permit portal.
 * Only allow:
 *   - .gov domains
 *   - known permit vendor domains
 */
export function validateURL(url) {
  if (!url) return null;

  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const lower = url.toLowerCase();

  // Known vendor fragments
  const vendors = [
    "accela",
    "energov",
    "tylerhost",
    "tylertech",
    "tylerportico",
    "citizenserve",
    "etrakit",
    "opengov",
    "cityview",
    "cvprodportal",
    "mygovernmentonline",
    "permiteyes",
    "viewpointcloud",
    "arcgis",
    "webgis",
    "gisweb"
  ];

  // All .gov portals are valid
  if (lower.endsWith(".gov")) return url;

  // Known vendor pattern
  if (vendors.some(v => lower.includes(v))) return url;

  return null;
}

/**
 * Vendor Detection
 */
export function detectVendor(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();

  if (lower.includes("accela")) return "Accela";

  if (lower.includes("energov") || lower.includes("tylerhost"))
    return "EnerGov";

  if (lower.includes("tylertech")) return "TylerTech";
  if (lower.includes("tylerportico")) return "TylerTech";

  if (lower.includes("etrakit")) return "eTrakit";

  if (lower.includes("citizenserve")) return "CitizenServe";

  if (lower.includes("opengov")) return "OpenGov";

  if (lower.includes("mygovernmentonline")) return "MyGovernmentOnline";

  if (lower.includes("permiteyes")) return "PermitEyes";

  if (lower.includes("viewpointcloud")) return "ViewPointCloud";

  // CityView portals
  if (lower.includes("cityview") || lower.includes("cvprodportal"))
    return "CityView";

  // ArcGIS / ESRI Web App
  if (
    lower.includes("arcgis") ||
    lower.includes("webgis") ||
    lower.includes("gisweb")
  ) {
    return "ESRI-WebGIS";
  }

  if (lower.endsWith(".gov")) return "municipal";

  return "unknown";
}

/**
 * Normalize Tyler OAuth redirects to the underlying EnerGov portal.
 * Example:
 *   https://identity.tylerportico.com/oauth2/...redirect_uri=https://xxx-energovpub.tylerhost.net/apps/selfservice/callback
 * → https://xxx-energovpub.tylerhost.net/apps/selfservice/
 */
export function normalizeTylerOAuth(url) {
  try {
    if (!url.includes("identity.tylerportico.com")) return null;

    const auth = new URL(url);
    const redirectUri = auth.searchParams.get("redirect_uri");
    if (!redirectUri) return null;

    const parsed = new URL(redirectUri);

    // Drop the /callback suffix
    const normalized =
      parsed.origin + parsed.pathname.replace(/\/callback.*/i, "/");

    return normalized;
  } catch (e) {
    return null;
  }
}

/**
 * HEAD check to see if a URL exists.
 */
export async function checkUrlAlive(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow"
    });

    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

/**
 * Light HTML sniff test to confirm page looks like a permit portal.
 * Scans first 5000 characters for relevant keywords.
 */
export async function looksLikePermitPortal(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow"
    });
    if (!res.ok) return false;

    const html = await res.text();
    const snippet = html.slice(0, 5000).toLowerCase();

    const keywords = [
      "permit",
      "permitting",
      "inspection",
      "apply",
      "application",
      "contractor",
      "selfservice",
      "self-service",
      "login",
      "plan review",
      "submit"
    ];

    let hits = 0;
    for (const k of keywords) {
      if (snippet.includes(k)) hits++;
    }

    // Require at least two signals
    return hits >= 2;
  } catch {
    return false;
  }
}
