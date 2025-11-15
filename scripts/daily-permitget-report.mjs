// scripts/daily-permitget-report.mjs

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  RESEND_API_KEY,
  REPORT_TO_EMAIL,
  REPORT_FROM_EMAIL,
  DAILY_AI_LIMIT = "25",
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("❌ Missing Supabase env vars.");
  process.exit(1);
}
if (!RESEND_API_KEY || !REPORT_TO_EMAIL || !REPORT_FROM_EMAIL) {
  console.error("❌ Missing email env vars (RESEND_API_KEY / REPORT_TO_EMAIL / REPORT_FROM_EMAIL).");
  process.exit(1);
}

async function sb(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error for ${path}: ${res.status} ${text}`);
  }

  return res.json();
}

function formatPercent(num) {
  if (num == null) return "—";
  return `${Number(num).toFixed(2)}%`;
}

function htmlEscape(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildReport() {
  // 1) Summary (permitget_summary view)
  const summaryRows = await sb("permitget_summary?select=*");
  const summary = summaryRows[0] || {
    total: 0,
    pending: 0,
    needs_verification: 0,
    verified: 0,
    verified_percent: 0,
  };

  // 2) Vendor distribution (permitget_vendor_distribution view)
  const vendors = await sb("permitget_vendor_distribution?select=*");

  // 3) AI usage (last 7 days)
  const aiUsage = await sb(
    "permitget_ai_daily_usage?select=day,requests_used,daily_limit&order=day.desc&limit=7"
  );

  const today = new Date().toISOString().slice(0, 10);

  // HTML email
  const html = `
  <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5;">
    <h2>PermitGet Daily Portal Discovery Report</h2>
    <p><strong>Date:</strong> ${today}</p>

    <h3>Pipeline Summary</h3>
    <ul>
      <li><strong>Total jurisdictions:</strong> ${summary.total}</li>
      <li><strong>Pending discovery:</strong> ${summary.pending}</li>
      <li><strong>Needs verification:</strong> ${summary.needs_verification}</li>
      <li><strong>Verified:</strong> ${summary.verified} (${formatPercent(summary.verified_percent)})</li>
    </ul>

    <h3>Vendor Distribution</h3>
    ${
      vendors.length === 0
        ? "<p>No vendors discovered yet.</p>"
        : `
          <table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr>
                <th align="left">Vendor</th>
                <th align="right">Count</th>
                <th align="right">Percent</th>
              </tr>
            </thead>
            <tbody>
              ${vendors
                .map(
                  v => `
                <tr>
                  <td>${htmlEscape(v.vendor_type || "unknown")}</td>
                  <td align="right">${v.count}</td>
                  <td align="right">${formatPercent(v.percent)}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        `
    }

    <h3>AI Usage (Last 7 Days)</h3>
    ${
      aiUsage.length === 0
        ? "<p>No AI usage recorded yet.</p>"
        : `
          <table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr>
                <th align="left">Day</th>
                <th align="right">Used</th>
                <th align="right">Limit</th>
              </tr>
            </thead>
            <tbody>
              ${aiUsage
                .map(
                  d => `
                <tr>
                  <td>${d.day}</td>
                  <td align="right">${d.requests_used}</td>
                  <td align="right">${d.daily_limit ?? DAILY_AI_LIMIT}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        `
    }

    <hr style="margin-top: 24px; margin-bottom: 8px;" />
    <p style="font-size: 12px; color: #666;">
      Generated automatically from GitHub Actions · Daily AI Limit: ${DAILY_AI_LIMIT}
    </p>
  </div>
  `;

  const text = `
PermitGet Daily Portal Discovery Report
Date: ${today}

Pipeline Summary
- Total jurisdictions: ${summary.total}
- Pending discovery: ${summary.pending}
- Needs verification: ${summary.needs_verification}
- Verified: ${summary.verified} (${formatPercent(summary.verified_percent)})

Vendor Distribution:
${vendors
  .map(
    v =>
      `- ${v.vendor_type || "unknown"}: ${v.count} (${formatPercent(v.percent)})`
  )
  .join("\n") || "  (no vendors yet)"}

AI Usage (Last 7 Days):
${aiUsage
  .map(
    d =>
      `- ${d.day}: ${d.requests_used}/${d.daily_limit ?? DAILY_AI_LIMIT} requests`
  )
  .join("\n") || "  (no usage yet)"}
`;

  return { html, text };
}

async function sendEmail({ html, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: REPORT_FROM_EMAIL,
      to: [REPORT_TO_EMAIL],
      subject: "PermitGet Daily Portal Discovery Report",
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error: ${res.status} ${body}`);
  }
}

(async () => {
  try {
    console.log("📊 Building PermitGet daily report...");
    const report = await buildReport();
    console.log("📧 Sending email via Resend...");
    await sendEmail(report);
    console.log("✅ Daily report sent.");
  } catch (err) {
    console.error("❌ Failed to send daily report:", err);
    process.exit(1);
  }
})();
