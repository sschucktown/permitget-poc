// scripts/testPortalUtils.mjs
// Integration test harness for portalUtils + detection logic

import {
  validateURL,
  detectVendor,
  normalizeTylerOAuth,
  checkUrlAlive,
  looksLikePermitPortal
} from "../lib/portalUtils.js";

async function testUrl(label, url) {
  console.log("────────────────────────────────────────────");
  console.log(`🔎 ${label}`);
  console.log(`URL: ${url}`);

  const validated = validateURL(url);
  console.log("✅ validateURL →", validated);

  const normalizedTyler = normalizeTylerOAuth(url);
  console.log("🔁 normalizeTylerOAuth →", normalizedTyler || "(none)");

  const vendor = detectVendor(normalizedTyler || url);
  console.log("🏷  detectVendor →", vendor);

  const target = normalizedTyler || validated;

  if (!target) {
    console.log("⛔ No valid target URL to check for alive/portal content.");
    return;
  }

  const alive = await checkUrlAlive(target);
  console.log("🌐 checkUrlAlive →", alive);

  if (!alive) {
    console.log("⛔ Skipping looksLikePermitPortal (URL not alive).");
    return;
  }

  const looksPortal = await looksLikePermitPortal(target);
  console.log("🏗  looksLikePermitPortal →", looksPortal);
}

async function main() {
  const tests = [
    {
      label: "Auburn, AL – ESRI WebGIS",
      url: "https://webgis.auburnalabama.org/permits"
    },
    {
      label: "Clay County, FL – Tyler/EnerGov OAuth redirect",
      url: "https://identity.tylerportico.com/oauth2/default/v1/authorize?client_id=0oabor38fhjF8TeQz4x7&redirect_uri=https%3A%2F%2Fclaycountyfl-energovpub.tylerhost.net%2Fapps%2Fselfservice%2Fcallback&response_type=id_token%20token&scope=openid%20email%20profile&state=4648b829267c4a46802c59fe90681388&nonce=93de6d710244472ebfe9c63eda68a0d3"
    },
    {
      label: "Clay County, FL – normalized EnerGov portal",
      url: "https://claycountyfl-energovpub.tylerhost.net/apps/selfservice/"
    },
    {
      label: "Cherokee GA – CityView login",
      url: "https://cityview.cherokeega.com/CVProdPortal/Account/Logon"
    },
    {
      label: "Sample PermitEyes portal",
      url: "https://permiteyes.us/avon/loginuser.php"
    },
    {
      label: "PDF-only example (should fail portal checks)",
      url: "https://www.coffeecountytn.gov/DocumentCenter/View/12345/Building_Permit_Application.pdf"
    },
    {
      label: "Random city homepage (should not pass portal sniff)",
      url: "https://www.example.com"
    }
  ];

  for (const t of tests) {
    try {
      await testUrl(t.label, t.url);
    } catch (err) {
      console.error(`❌ Error testing "${t.label}":`, err.message);
    }
  }

  console.log("────────────────────────────────────────────");
  console.log("✅ Portal utils test run complete.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
