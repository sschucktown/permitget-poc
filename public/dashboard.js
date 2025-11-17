// -----------------------------------------------------------------------------
// Dashboard Frontend Script — FULL REWRITE
// -----------------------------------------------------------------------------

// Standardized JSON fetch with clear error surfacing
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed: ${res.status} – ${text}`);
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// LOAD TOP METRICS + RECENT DISCOVERIES + CHARTS
// -----------------------------------------------------------------------------

async function loadDashboard() {
  try {
    const [pending, usage, recent] = await Promise.all([
      fetchJSON("/api/dashboard/pending"),
      fetchJSON("/api/dashboard/usage"),
      fetchJSON("/api/dashboard/recent")
    ]);

    // ---------------------------------------------
    // TOP CARDS
    // ---------------------------------------------
    document.getElementById("pendingCount").textContent =
      pending.count ?? "–";

    document.getElementById("usageToday").textContent =
      usage.today?.count ?? 0;

    document.getElementById("usageLimit").textContent =
      `Daily limit: ${usage.limit}`;

    // Display last portal discovery
    if (recent.rows?.length > 0) {
      const last = recent.rows[0];
      const portal = last.portal_url || "(none)";
      document.getElementById("lastPortal").textContent =
        `${last.name} → ${portal}`;
    }

    // ---------------------------------------------
    // RECENT DISCOVERIES TABLE
    // ---------------------------------------------
    const tbody = document.getElementById("recentTable");
    tbody.innerHTML = "";

    (recent.rows || []).forEach(row => {
      if (!row || typeof row !== "object") return;

      const tr = document.createElement("tr");
      tr.className = "border-b";

      tr.innerHTML = `
        <td class="p-2">${row.name ?? "—"}</td>

        <td class="p-2">
          ${row.portal_url
            ? `<a href="${row.portal_url}" class="text-blue-600 underline" target="_blank">${row.portal_url}</a>`
            : "<span class='text-gray-400'>—</span>"}
        </td>

        <td class="p-2">${row.vendor_type ?? "—"}</td>

        <td class="p-2">${row.updated_at
            ? new Date(row.updated_at).toLocaleDateString()
            : "—"}
        </td>
      `;

      tbody.appendChild(tr);
    });

    // ---------------------------------------------
    // AI USAGE CHART
    // ---------------------------------------------
    const usageLabels = usage.last14?.map(d => d.day) ?? [];
    const usageValues = usage.last14?.map(d => d.count) ?? [];

    new Chart(document.getElementById("aiUsageChart"), {
      type: "line",
      data: {
        labels: usageLabels,
        datasets: [{
          label: "AI Calls",
          data: usageValues,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.2)",
          tension: 0.25,
          borderWidth: 2
        }]
      }
    });

    // ---------------------------------------------
    // VENDOR PIE CHART
    // ---------------------------------------------
    const vendorCounts = recent.vendorBreakdown ?? {};
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

  } catch (err) {
    console.error("loadDashboard error:", err);
  }
}

// -----------------------------------------------------------------------------
// HUMAN REVIEW QUEUE
// -----------------------------------------------------------------------------

async function loadReviewQueue() {
  try {
    const res = await fetch("/api/dashboard/review/list");
    const data = await res.json();

    let rows = data?.rows ?? [];
    rows = Array.isArray(rows) ? rows : [];

    const tbody = document.getElementById("reviewTable");
    tbody.innerHTML = "";

    rows.forEach(r => {
      if (!r || typeof r !== "object") return;

      const tr = document.createElement("tr");
      tr.className = "border-b";

      tr.innerHTML = `
        <td class="p-2">${r.name ?? "—"}</td>

        <td class="p-2">
          ${r.suggested_url
            ? `<a href="${r.suggested_url}" class="text-blue-600 underline" target="_blank">${r.suggested_url}</a>`
            : "—"}
        </td>

        <td class="p-2">${r.vendor_type ?? "—"}</td>

        <td class="p-2">${r.created_at
            ? new Date(r.created_at).toLocaleString()
            : "—"}
        </td>

        <td class="p-2">
          <button data-id="${r.id}" data-action="approve"
            class="bg-green-600 text-white px-3 py-1 rounded mr-2">
            Approve
          </button>

          <button data-id="${r.id}" data-action="reject"
            class="bg-red-600 text-white px-3 py-1 rounded">
            Reject
          </button>
        </td>
      `;

      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error("loadReviewQueue error:", err);
  }
}

// -----------------------------------------------------------------------------
// APPROVE / REJECT HANDLER
// -----------------------------------------------------------------------------

document.addEventListener("click", async event => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;

  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (!id || !action) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent =
    action === "approve" ? "Approving…" : "Rejecting…";

  try {
    const endpoint =
      action === "approve"
        ? "/api/dashboard/review/approve"
        : "/api/dashboard/review/reject";

    await fetchJSON(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });

    // Refresh both panels
    await loadDashboard();
    await loadReviewQueue();

  } catch (err) {
    console.error(`${action} error:`, err);
    alert(`Failed to ${action}: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// -----------------------------------------------------------------------------
// INITIAL PAGE LOAD
// -----------------------------------------------------------------------------

loadDashboard();
loadReviewQueue();
