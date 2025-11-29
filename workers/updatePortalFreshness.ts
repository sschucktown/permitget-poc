// workers/updatePortalFreshness.ts
import { createHash } from "crypto";

export async function updatePortalFreshness(portalId: number) {
  const { data: snaps, error } = await supabase
    .from("portal_snapshots")
    .select("id, raw_hash, created_at")
    .eq("portal_id", portalId)
    .order("created_at", { ascending: false })
    .limit(2);

  if (error) throw error;

  const [latest, previous] = snaps || [];

  const changed = previous && latest && latest.raw_hash !== previous.raw_hash;

  const now = new Date();
  const ageDays = latest
    ? Math.floor((now.getTime() - new Date(latest.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  const freshnessScore = Math.max(0, 100 - ageDays * 5); // very rough v1 heuristic

  await supabase
    .from("portal_endpoints")
    .update({
      change_hash: latest?.raw_hash ?? null,
      last_checked_at: now.toISOString(),
      freshness_score: freshnessScore
    })
    .eq("id", portalId);

  return { changed, freshnessScore };
}
