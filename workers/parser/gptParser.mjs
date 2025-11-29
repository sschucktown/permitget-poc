import { createClient } from "@supabase/supabase-js";
import pdf from "pdf-parse";
import fetch from "node-fetch";
import OpenAI from "openai";

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

// -----------------------------
// Helper: download file buffer
// -----------------------------
async function downloadFile(path) {
  const { data, error } = await supabase.storage
    .from("portal_snapshots")
    .download(path);

  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

// -----------------------------
// Helper: extract text from pdf
// -----------------------------
async function extractPdfText(buffer) {
  const data = await pdf(buffer);
  return data.text;
}

// -----------------------------
// Helper: generate GPT extraction
// -----------------------------
async function parseWithGPT(text, metadata) {
  const prompt = `
You are parsing permitting data from a city or county permit portal.
Extract ALL structured data in JSON ONLY, no comments.

Return JSON with the following shape:

{
  "permit_types": [ { "name": "", "category": "", "description": "" } ],
  "forms": [ { "permit_type": "", "form_name": "", "form_url": "", "required": true } ],
  "fees": [ { "permit_type": "", "fee_name": "", "amount": "", "formula": "", "notes": "" } ],
  "requirements": [ { "permit_type": "", "requirement": "", "category": "", "notes": "" } ],
  "contacts": [ { "department": "", "name": "", "phone": "", "email": "", "hours": "", "address": "", "url": "" } ],
  "links": [ { "link_type": "", "link_url": "", "link_title": "" } ],
  "inspections": [ { "permit_type": "", "inspection_name": "", "description": "", "notes": "" } ],
  "notes": [ { "note": "" } ]
}

If data is missing, return empty arrays for each field.

---
CONTEXT:
Vendor: ${metadata.vendor}
URL: ${metadata.url}
Jurisdiction: ${metadata.jurisdiction_geoid}
---
CONTENT:
${text}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a permit data extraction engine." },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  });

  const json = JSON.parse(response.choices[0].message.content);
  return json;
}

// -----------------------------
// Main parser entry point
// -----------------------------
export async function parseSnapshot(snapshot) {
  const { id, hash, url, vendor, jurisdiction_geoid, snapshot_url } = snapshot;

  console.log(`\n🔎 Parsing snapshot ${id} (${vendor})`);

  try {
    // 1. Download HTML or PDF
    const buffer = await downloadFile(snapshot_url);

    let text = "";
    if (snapshot_url.endsWith(".pdf")) {
      console.log("📄 Extracting text from PDF…");
      text = await extractPdfText(buffer);
    } else {
      console.log("🌐 Extracting text from HTML…");
      text = buffer.toString("utf-8");
    }

    // 2. Run GPT extraction
    const structured = await parseWithGPT(text, {
      vendor,
      url,
      jurisdiction_geoid,
    });

    console.log("✨ Parsed with GPT");

    // 3. Insert into permit_parsed
    const { data: parsedRow, error: parsedErr } = await supabase
      .from("permit_parsed")
      .insert({
        snapshot_id: id,
        jurisdiction_geoid,
        url,
        vendor,
      })
      .select("id")
      .single();

    if (parsedErr) throw parsedErr;

    const parsed_id = parsedRow.id;

    // Helper function for batch inserts
    async function insertIfNotEmpty(table, rows) {
      if (!rows || rows.length === 0) return;
      const cleaned = rows.map((r) => ({ ...r, parsed_id }));
      const { error } = await supabase.from(table).insert(cleaned);
      if (error) console.error(`❌ Insert error in ${table}:`, error);
    }

    // 4. Insert each collection
    await insertIfNotEmpty("permit_types", structured.permit_types);
    await insertIfNotEmpty("permit_forms", structured.forms);
    await insertIfNotEmpty("permit_fees", structured.fees);
    await insertIfNotEmpty("permit_requirements", structured.requirements);
    await insertIfNotEmpty("permit_contacts", structured.contacts);
    await insertIfNotEmpty("permit_links", structured.links);
    await insertIfNotEmpty("permit_inspections", structured.inspections);
    await insertIfNotEmpty("permit_notes", structured.notes);

    // 5. Mark parsed
    await supabase
      .from("portal_snapshots")
      .update({ parsed: true })
      .eq("id", id);

    console.log(`✅ Snapshot ${id} parsed successfully`);

  } catch (err) {
    console.error("❌ GPT parsing error:", err);

    await supabase
      .from("portal_snapshots")
      .update({ parsed: false, last_error: err.toString() })
      .eq("id", snapshot.id);
  }
}
