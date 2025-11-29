// workers/parsePortalSnapshot.ts
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function parsePortalSnapshot(snapshotId: number) {
  const { data: snap, error } = await supabase
    .from("portal_snapshots")
    .select("*")
    .eq("id", snapshotId)
    .single();
  if (error) throw error;

  const { data: file } = await supabase.storage.from("crawler").download(snap.storage_path);
  const html = await file.text();

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a parser that extracts permit portal metadata into a fixed JSON schema: permit types, forms, URLs, fees."
      },
      {
        role: "user",
        content: html
      }
    ],
    response_format: { type: "json_object" }
  });

  const parsed = JSON.parse(resp.choices[0].message.content || "{}");

  await supabase
    .from("portal_snapshots")
    .update({
      parsed_payload: parsed,
      confidence_score: parsed.confidence_score ?? 0.8
    })
    .eq("id", snapshotId);

  return parsed;
}
