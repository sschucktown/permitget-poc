// lib/portalUtils.js
import fetch from "node-fetch";

/**
 * Validate a URL as a possible official permit portal.
 * Must be:
 *   - a .gov domain OR
 *   - a known vendor domain
 */
export function validateURL(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return null;
  if (!url.includes(".")) return null;

  const lower = url.toLowerCase();

  const vendors = [
    "accela.com",
    "energov",
    "etrakit",
    "citizenserve.com",
    "tylertech.com",
    "mygovernmentonline.org",
    "opengov",
    "viewpointcloud",
    "cityview",
    "permiteyes",
    "webgis",              // ESRI WebGIS
    "arcgis"               // ESRI / ArcGIS Web App
  ];

  // Government domain is always valid
  if (lower.endsWith(".gov")) return url;

  // Vendor match
  if (vendors.some(v => lower.includes(v))) return url;

  return null;
}

/**
 * Detect the permitting vendor from URL.
 */
export function detectVendor(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();

  // --- NEW: ESRI / ArcGIS GIS Web Portal ---
  if (
    lower.includes("webgis") ||
    lower.includes("arcgis") ||
    lower.includes("gisweb")
  ) {
    return "esri-webapp";
  }

  // --- NEW: PermitEyes ---
  if (lower.includes("permiteyes")) return "PermitEyes";

  // Standard vendor patterns
  if (lower.includes("accela")) return "Accela";
  if (lower.includes("energov")) return "EnerGov";
  if (lower.includes("etrakit")) return "eTrakit";
  if (lower.includes("citizenserve")) return "CitizenServe";
  if (lower.includes("tylertech")) return "TylerTech";
  if (lower.includes("mygovernmentonline")) return "MyGovernmentOnline";
  if (lower.includes("opengov")) return "OpenGov";
  if (lower.includes("viewpointcloud")) return "ViewPointCloud";
  if (lower.includes("cityview")) return "CityView";

  // Generic fallback: govt portal but unknown vendor
  if (lower.endsWith(".gov")) return "municipal";

  return "unknown";
}

/**
 * HEAD-ping to verify URL is alive
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
 * Check if page looks like an actual permit portal.
 * Minimal heuristics: must have ≥2 keywords related to permits.
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

    const mustHave = [
      "permit",
      "permitting",
      "contractor",
      "building",
      "apply",
      "application",
      "inspections",
      "portal",
      "submit"
    ];

    let hits = 0;
    for (const word of mustHave) {
      if (snippet.includes(word)) hits++;
    }

    return hits >= 2;
  } catch {
    return false;
  }
}
