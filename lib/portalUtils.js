// lib/portalUtils.js
import fetch from "node-fetch";

/**
 * Validate a candidate URL as a possible online permit portal.
 * Only allow:
 *   - .gov domains
 *   - known vendor domains (Accela, EnerGov, TylerHost, PermitEyes, etc.)
 */
export function validateURL(url) {
  if (!url) return null;

  // Basic structure
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
    "mygovernmentonline",
    "permit",          // catches PermitEyes
    "viewpointcloud",
    "arcgis",
    "webgis",
    "gisweb"
  ];

  // Government domains are always valid
  if (lower.endsWith(".gov")) return url;

  // Vendor match
  if (vendors.some(v => lower.includes(v))) return url;

  return null;
}

/**
 * Vendor detection from URL.
 * Returns the canonical vendor name.
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

  if (lower.includes("permit") && lower.includes("eyes"))
    return "PermitEyes";

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

  // Generic municipal portal
  if (lower.endsWith(".gov")) return "municipal";

  return "unknown";
}

/**
 * Detect and normalize Tyler OAuth → the underlying EnerGov SelfService portal.
 * Example:
 *   https://identity.tylerportico.com/...redirect_uri=https://xxx-energovpub.tylerhost.net/apps/selfservice/callback
 * → https://xxx-energovpub.tylerhost.net/apps/selfservice/
 */
export function normalizeTylerOAuth(url) {
  try {
    if (!url.includes("identity.tylerportico.com")) return null;

    const authUrl = new URL(url);
    const redirectUri = authUrl.searchParams.get("redirect_uri");
    if (!redirectUri) return null;

    const parsed = new URL(redirectUri);

    // Strip off "/callback" and leave the base selfservice folder
    const normalized = parsed.origin + parsed.pathname.replace(/\/callback.*/i, "/");
    return normalized;

  } catch (_e) {
    return null;
  }
}

/**
 * HEAD → verify URL actually exists.
 */
export async function checkUrlAlive(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      timeout: 8000
    });

    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

/**
 * Light content sniff — returns true if page contains permit-portal signals.
 * We only scan the first 5000 chars for efficiency.
 */
export async function looksLikePermitPortal(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      timeout: 8000
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

    return hits >= 2;
  } catch {
    return false;
  }
}
