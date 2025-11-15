async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

async function loadDashboard() {
  // --- Fetch all data
  const [pending, usage, recent] = await Promise.all([
    fetchJSON("/api/dashboard/pending"),
    fetchJSON("/api/dashboard/usage"),
    fetchJSON("/api/dashboard/recent")
  ]);

  // ------------------------------------------
  // TOP CARDS
  // ------------------------------------------
  document.getElementById("pendingCount").textContent =
    pending.count ?? "–";

  document.getElementById("usageToday").textContent =
    usage.today.count ?? "0";

  document.getElementById("usageLimit").textContent =
    `Daily limit: ${usage.limit}`;

  if (recent.rows.length > 0) {
    const last = recent.rows[0];
    document.getElementById("lastPortal").textContent =
      `${last.name} → ${last.portal_url}`;
  }

  // ------------------------------------------
  // RENDER RECENT TABLE
  // ------------------------------------------
  const tbody = document.getElementById("recentTable");
  tbody.innerHTML = "";

  recent.rows.forEach(r => {
    const tr = document.createElement("tr");
    tr.className = "border-b";
    tr.innerHTML = `
      <td class="p-2">${r.name}</td>
      <td class="p-2"><a href="${r.portal_url}" class="text-blue-600 underline" target="_blank">${r.portal_url}</a></td>
      <td class="p-2">${r.vendor_type ?? "–"}</td>
      <td class="p-2">${new Date(r.updated_at).toLocaleDateString()}</td>
    `;
    tbody.appendChild(tr);
  });

  // ------------------------------------------
  // AI USAGE CHART
  // ------------------------------------------
  const usageLabels = usage.last14.map(d => d.day);
  const usageValues = usage.last14.map(d => d.count);

  new Chart(document.getElementById("aiUsageChart"), {
    type: "line",
    data: {
      labels: usageLabels,
      datasets: [{
        label: "AI Calls",
        data: usageValues,
        borderColor: "#2563eb",
        backgroundColor: "rgba(37, 99, 235, 0.2)",
        borderWidth: 2
      }]
    }
  });

  // ------------------------------------------
  // VENDOR PIE CHART
  // ------------------------------------------
  const vendorCounts = recent.vendorBreakdown;
  const vendorLabels = Object.keys(vendorCounts);
  const vendorValues = Object.values(vendorCounts);

  new Chart(document.getElementById("vendorChart"), {
    type: "pie",
    data: {
      labels: vendorLabels,
      datasets: [{
        data: vendorValues,
        backgroundColor: [
          "#3b82f6",
          "#10b981",
          "#f59e0b",
          "#ef4444",
          "#6366f1",
          "#14b8a6"
        ]
      }]
    }
  });

}

loadDashboard();
