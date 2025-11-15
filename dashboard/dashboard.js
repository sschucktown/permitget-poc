async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

async function loadStats() {
  const [usage, pending, recent] = await Promise.all([
    fetchJSON("/api/dashboard/usage"),
    fetchJSON("/api/dashboard/pending"),
    fetchJSON("/api/dashboard/recent")
  ]);

  document.getElementById("aiCount").textContent = usage.used;
  document.getElementById("aiRemaining").textContent = usage.remaining;
  document.getElementById("pendingCount").textContent = pending.count;

  const table = document.getElementById("recentTable");
  table.innerHTML = "";

  recent.rows.forEach(row => {
    const tr = document.createElement("tr");
    tr.classList.add("border-b");

    tr.innerHTML = `
      <td class="py-2 px-2">${row.jurisdiction_geoid}</td>
      <td class="py-2 px-2">${row.jurisdiction_name}</td>
      <td class="py-2 px-2">
        <a href="${row.portal_url}" target="_blank" class="text-blue-600 underline">
        ${row.portal_url}
        </a>
      </td>
      <td class="py-2 px-2">${row.vendor_type}</td>
      <td class="py-2 px-2">${new Date(row.updated_at).toLocaleString()}</td>
    `;

    table.appendChild(tr);
  });
}

loadStats();
setInterval(loadStats, 15000);
