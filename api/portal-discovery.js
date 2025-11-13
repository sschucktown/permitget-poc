import OpenAI from "openai";

export default async function handler(req, res) {
  const { geoid, name } = req.query;

  if (!geoid || !name) {
    return res.status(400).json({ error: "Missing geoid or name" });
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const prompt = `
You are a permitting portal discovery agent.

Find the OFFICIAL online permitting portal for:
- Jurisdiction name: ${name}
- GEOID: ${geoid}

Return JSON in this format only:
{
  "portal_url": "...",
  "portal_status": "working|unknown|offline",
  "submission_method": "online|pdf|email|in-person",
  "notes": "..."
}
`;

  const result = await client.responses.create({
    model: "gpt-4.1",
    input: prompt
  });

  return res.json(result.output[0].content[0].text);
}
