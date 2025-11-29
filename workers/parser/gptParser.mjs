// ============================================================
// GPT Permit Parser
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);   // Needed for pdf-parse CJS
const pdf = require("pdf-parse");                 // Correct import
import fetch from "node-fetch";
import OpenAI from "openai";

// -----------------------------
// Initialize OpenAI
// -----------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------
// Supabase Client
// -----------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

// ============================================================
// Helper: download HTML/PDF from Supabase Storage
// ============================================================
async function downloadFile(path) {
  const { data, error } = await supabase.storage
    .from("portal_snapshots")
    .download(path);

  if (error) throw error;

  return Buffer.from(await data.arrayBuffer());
}

// ============================================================
// Helper: extract text from PDF
// ============================================================
async function extractPdfText(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text || "";
  } catch (err) {
    console.error("❌ PDF parse error:", err);
    return "";
  }
}

// ============================================================
// GPT Extraction Prompt
// ============================================================
async function parseWithGPT(text, metadata) {
  const prompt = `
You are a permitting data extraction engine.

Extract ALL permitting data from the provided text and return JSON ONLY, no commentary.

JSON shape:

{
  "permit_types": [
    { "name": "", "category": "", "description": "", "notes": "" }
  ],
  "forms": [
    { "permit_type": "", "form_name": "", "form_url": "", "form_type": "", "required": false }
  ],
  "fees": [
    { "permit_type": "", "fee_name": "", "amount": "", "formula": "", "notes": "" }
  ],
  "requirements": [
    { "permit_type": "", "requirement": "", "category": "", "notes": "" }
  ],
  "contacts": [
    { "department": "", "name": "", "phone": "", "email": "", "hours": "", "address": "", "url": "" }
  ],
  "links": [
    { "link_type": "", "link_url": "", "link_title": "" }
  ],
  "inspections": [
    { "permit_type": "", "inspection_name": "", "description": "", "notes": "" }
  ],
  "notes": [
    { "note": "" }
  ]
}

If information is missing, return empty arrays.

---
METADATA:
Vendor: ${metadata.vendor}
URL: ${metadata.url}
Jurisdiction: ${metadata.jurisdiction_geoid}

---
CONTENT:
${text}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: "You are a permit data extraction engine." },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch (err) {
    console.error("❌ JSON parse error:", content);
    throw err;
  }
}

// ============================================================
// Main parser entry point
// ============================================================
export async function parseSnapshot(snapshot) {
  const { id, snapshot_url, url, vendor, jurisdiction_geoid } = snapshot;

  console.log(`\n🔎 Parsing snapshot ${id} (${vendor})`);

  try {
    // -----------------------------
    // 1. Download snapshot
    // -----------------------------
    const buffer = await downloadFile(snapshot_url);
    let text = "";

    if (snapshot_url.endsWith(".pdf")) {
      console.log("📄 Extracting PDF text…");
      text = await extractPdfText(buffer);
    } else {
      console.log("🌐 Extracting HTML text…");
      text = buffer.toString("utf-8");
    }

    // -----------------------------
    // 2. Parse using GPT
    // -----------------------------
    const structured = await parseWithGPT(text, {
      vendor,
      url,
      jurisdiction_geoid,
    });

    console.log("✨ GPT extraction completed");

    // -----------------------------
    // 3. Insert core parsed record
    // -----------------------------
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

    // -----------------------------
    // Helper for inserting rows
    // -----------------------------
    async function insertRows(table, rows) {
      if (!rows || rows.length === 0) return;
      const payload = rows.map((r) => ({ ...r, parsed_id }));
      const { error } = await supabase.from(table).insert(payload);
      if (error) console.error(`❌ Insert error in ${table}:`, error);
    }

    // -----------------------------
    // 4. Insert normalized data
    // -----------------------------
    await insertRows("permit_types", structured.permit_types);
    await insertRows("permit_forms", structured.forms);
    await insertRows("permit_fees", structured.fees);
    await insertRows("permit_requirements", structured.requirements);
    await insertRows("permit_contacts", structured.contacts);
    await insertRows("permit_links", structured.links);
    await insertRows("permit_inspections", structured.inspections);
    await insertRows("permit_notes", structured.notes);

    // -----------------------------
    // 5. Mark snapshot parsed
    // -----------------------------
    await supabase
      .from("portal_snapshots")
      .update({ parsed: true })
      .eq("id", id);

    console.log(`✅ Snapshot ${id} parsed successfully`);

  } catch (err) {
    console.error("❌ GPT parser error:", err);

    await supabase
      .from("portal_snapshots")
      .update({ parsed: false, last_error: err.toString() })
      .eq("id", snapshot.id);
  }
}
