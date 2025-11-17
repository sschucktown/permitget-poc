// public/dashboard.js

// -----------------------------------------------------------------------------
// Standard JSON helper
// -----------------------------------------------------------------------------
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

    // Pending count
    document.getElementById("pendingCount").textContent =
      pending.count ?? "–";

    // AI usage today
    document.getElementById("usageToday").textContent =
      usage.today?.count ?? 0;
    document.getElementById("usageLimit").textContent =
      `Daily limit: ${usage.limit}`;

    // Last portal
    if (recent.rows?.length > 0) {
      const last = recent.rows[0];
      const portal = last.portal_url || "(none)";
      document.getElementById("lastPortal").textContent =
        `${last.name} → ${portal}`;
    }

    // Recent table
    const tbody = document.getElementById("recentTable");
    tbody.innerHTML = "";

    (recent.rows || []).forEach(row => {
      if (!row || typeof row !== "object") return;

      const tr = document.createElement("tr");
      tr.className = "border-b";

      tr.innerHTML = `
        <td class="p-2">${row.name ?? "—"}</td>
        <td class="p-2">
          ${
            row.portal_url
              ? `<a href="${row.portal_url}" class="text-blue-600 underline" target="_blank">${row.portal_url}</a>`
              : "<span class='text-gray-400'>—</span>"
          }
        </td>
        <td class="p-2">${row.vendor_type ?? "—"}</td>
        <td class="p-2">${
          row.updated_at
            ? new Date(row.updated_at).toLocaleDateString()
            : "—"
        }</td>
      `;

      tbody.appendChild(tr);
    });

    // AI Usage Chart
    const usageLabels = usage.last14?.map(d => d.day) ?? [];
    const usageValues = usage.last14?.map(d => d.count) ?? [];

    new Chart(document.getElementById("aiUsageChart"), {
      type: "line",
      data: {
        labels: usageLabels,
        datasets: [
          {
            label: "AI Calls",
            data: usageValues,
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.2)",
            tension: 0.25,
            borderWidth: 2
          }
        ]
      }
    });

    // Vendor Pie Chart
    const vendorCounts = recent.vendorBreakdown ?? {};
    const vendorLabels = Object.keys(vendorCounts);
    const vendorValues = Object.values(vendorCounts);

    new Chart(document.getElementById("vendorChart"), {
      type: "pie",
      data: {
        labels: vendorLabels,
        datasets: [
          {
            data: vendorValues,
            backgroundColor: [
              "#3b82f6",
              "#10b981",
              "#f59e0b",
              "#ef4444",
              "#6366f1",
              "#14b8a6"
            ]
          }
        ]
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
    const data = await fetchJSON("/api/dashboard/review/list");
    let rows = Array.isArray(data.rows) ? data.rows : [];

    const tbody = document.getElementById("reviewTable");
    const countSpan = document.getElementById("reviewCount");

    tbody.innerHTML = "";
    countSpan.textContent = `${rows.length} item(s) awaiting review`;

    rows.forEach(r => {
      if (!r || typeof r !== "object") return;

      const tr = document.createElement("tr");
      tr.className = "border-b align-top";

      const suggestedUrl = r.suggested_url ?? "";
      const aiNotes = r.ai_notes ?? "";

      tr.innerHTML = `
        <td class="p-2">
          <div class="font-semibold">${r.name ?? "—"}</div>
          <div class="text-xs text-gray-500">
            GEOID: ${r.jurisdiction_geoid ?? "—"} · ${r.level ?? ""} · ${r.statefp ?? ""}
          </div>
          <div class="text-xs text-gray-400 mt-1">
            Created: ${
              r.created_at
                ? new Date(r.created_at).toLocaleString()
                : "—"
            }
          </div>
        </td>

        <td class="p-2">
          ${
            suggestedUrl
              ? `<a href="${suggestedUrl}" class="text-blue-600 underline break-all" target="_blank">${suggestedUrl}</a>`
              : "<span class='text-gray-400'>—</span>"
          }
        </td>

        <td class="p-2">
          ${r.vendor_type ?? "—"}
        </td>

        <td class="p-2 text-sm">
          ${
            aiNotes
              ? `<div class="whitespace-pre-wrap">${aiNotes}</div>`
              : "<span class='text-gray-400'>—</span>"
          }
        </td>

        <td class="p-2 text-sm">
          <div class="space-y-2">

            <div>
              <label class="block text-xs text-gray-500 mb-1">
                Correct Portal URL (leave blank if none)
              </label>
              <input
                type="text"
                class="w-full border rounded px-2 py-1 text-xs"
                data-field="portal_url"
                placeholder="https://..."
                value="${suggestedUrl ? suggestedUrl : ""}"
              />
            </div>

            <div>
              <label class="block text-xs text-gray-500 mb-1">
                Manual Info URL (PDFs / instructions)
              </label>
              <input
                type="text"
                class="w-full border rounded px-2 py-1 text-xs"
                data-field="manual_info_url"
                placeholder="https://... (if offline only)"
                value="${r.manual_info_url ?? ""}"
              />
            </div>

            <div>
              <label class="block text-xs text-gray-500 mb-1">
                Human Notes
              </label>
              <input
                type="text"
                class="w-full border rounded px-2 py-1 text-xs"
                data-field="human_notes"
                placeholder="Why approved/rejected, offline notes, etc."
                value="${r.human_notes ?? ""}"
              />
            </div>

            <div class="mt-2 flex gap-2">
              <button
                data-id="${r.id}"
                data-action="approve"
                class="approveBtn bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-xs"
              >
                Approve
              </button>

              <button
                data-id="${r.id}"
                data-action="reject"
                class="rejectBtn bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-xs"
              >
                Reject
              </button>
            </div>
          </div>
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

  const row = btn.closest("tr");
  if (!row) return;

  const portalInput = row.querySelector('input[data-field="portal_url"]');
  const manualInput = row.querySelector('input[data-field="manual_info_url"]');
  const notesInput = row.querySelector('input[data-field="human_notes"]');

  const portal_url = portalInput?.value?.trim() || "";
  const manual_info_url = manualInput?.value?.trim() || "";
  const human_notes = notesInput?.value?.trim() || "";

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
      body: JSON.stringify({
        id,
        portal_url,
        manual_info_url,
        human_notes
      })
    });

    // Reload dashboard + review queue
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
