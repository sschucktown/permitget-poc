// lib/portalUtils.js
import fetch from "node-fetch";

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
    "cityview"
  ];

  if (lower.endsWith(".gov")) return url;
  if (vendors.some(v => lower.includes(v))) return url;

  return null;
}

export function detectVendor(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();

  const vendorMap = {
    accela: "accela.com",
    energov: "energov",
    etrakit: "etrakit",
    citizenserve: "citizenserve.com",
    tyler: "tylertech.com",
    mygov: "mygovernmentonline.org",
    opengov: "opengov",
    viewpoint: "viewpointcloud",
    cityview: "cityview"
  };

  for (const [name, match] of Object.entries(vendorMap)) {
    if (lower.includes(match)) return name;
  }

  if (lower.endsWith(".gov")) return "municipal";
  return "unknown";
}

export function normalizeTylerOAuth(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const redirect =
      parsed.searchParams.get("redirect_uri") ||
      parsed.searchParams.get("redirect");

    if (redirect && (host.includes("tylertech.com") || host.includes("tylerportico.com"))) {
      return decodeURIComponent(redirect);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * HEAD request - check if URL is alive
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
 * Light-content check to see if page looks like a permit portal.
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

    const mustHave = ["permit", "permitting", "contractor", "building", "apply"];
    let hits = 0;
    for (const word of mustHave) {
      if (snippet.includes(word)) hits++;
    }

    return hits >= 2;
  } catch {
    return false;
  }
}
