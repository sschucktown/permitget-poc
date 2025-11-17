// lib/offlineClassifier.js

export function classifyOffline(content, links) {
  const result = {
    isOffline: false,
    confidence: 0
  };

  if (!content || !links) return result;

  const text = content.toLowerCase();
  const pdfLinks = links.filter(l => l.url.toLowerCase().endsWith(".pdf"));
  const nonPdfLinks = links.filter(l => !l.url.toLowerCase().endsWith(".pdf"));

  // 1. Detect vendor systems (if any found → NOT offline)
  const vendorPatterns = [
    "opengov",
    "permiteyes",
    "epermithub",
    "tylertech",
    "citytech",
    "mygovernmentonline",
    "smartgov",
    "permitcenter",
    "cloudpermit",
    "citizenserve"
  ];

  if (nonPdfLinks.some(l => vendorPatterns.some(v => l.url.includes(v)))) {
    return { isOffline: false, confidence: 0 };
  }

  // 2. Check if all links are PDFs or internal CivicPlus links
  const pdfRatio = pdfLinks.length / (links.length || 1);

  // 3. Offline language
  const offlineIndicators = [
    "pdf",
    "print",
    "mail",
    "fee schedule",
    "codes & compliance",
    "download",
    "forms",
    "applications",
    "permit packet",
    "return completed"
  ];

  const offlineHits = offlineIndicators.filter(w => text.includes(w)).length;

  // 4. Online submission indicators (if any found → NOT offline)
  const onlineIndicators = [
    "apply online",
    "submit online",
    "/login",
    "/account",
    "/application",
    "portal"
  ];

  if (onlineIndicators.some(w => text.includes(w))) {
    return { isOffline: false, confidence: 0 };
  }

  // Combine scores
  let score = 0;

  if (pdfRatio > 0.5) score += 0.4;           // mostly PDF based
  if (offlineHits > 2) score += 0.4;          // language supports offline
  if (pdfRatio === 1) score += 0.2;           // exclusively PDF
  if (nonPdfLinks.length === 0) score += 0.2; // no online links at all

  result.isOffline = score >= 0.5;
  result.confidence = score;

  return result;
}
