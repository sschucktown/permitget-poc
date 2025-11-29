import { detectPortalsForCounty } from "./detectPortalsForCounty.mjs";

console.log("🚀 Running portal detection...");

detectPortalsForCounty("45019")  // Charleston County

  .then((c) => {
    console.log(`🎉 Portal detection complete. ${c} endpoints found.`);
  })
  .catch((err) => {
    console.error("❌ Error in portal detection:", err);
    process.exit(1);
  });
