import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { normalizeCharacterProfile } from "@/lib/character-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 12_000;
const REFLECTION_TOPIC_ALLOWLIST = new Set([
  "music", "visual art", "design", "mythology", "language", "history", "philosophy",
  "astronomy", "literature", "architecture", "nature", "science", "games", "film",
]);

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function authorizedClient(request: Request): Promise<{ client: SupabaseClient; userId: string }> {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) throw new ApiError("Sign in to manage FREYA's persistent character profile.", 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ApiError("Cloud character storage is not configured.", 503);
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new ApiError("Sign-in session is invalid or expired.", 401);
  return { client, userId: data.user.id };
}

async function appendRevision(client: SupabaseClient, profile: unknown, summary: string, rollbackFrom: number | null = null) {
  const normalized = normalizeCharacterProfile(profile);
  const { data, error } = await client.rpc("append_freya_personality_revision", {
    p_profile: normalized,
    p_summary: summary.slice(0, 500),
    p_rollback_from: rollbackFrom,
  });
  if (error) throw new ApiError("Could not save the character profile revision.", 503);
  const revision = data as number;
  const stamped = normalizeCharacterProfile({
    ...normalized,
    preferences: normalized.preferences.map((item) => ({ ...item, revision })),
  });
  return { revision, profile: stamped };
}

async function readBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError("Request is too large.", 413);
  if (!request.body) throw new ApiError("Request body must be a JSON object.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError("Request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError("Request body must be a JSON object.", 400); }
}

function fail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "FREYA's character profile could not be loaded." }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    const { client, userId } = await authorizedClient(request);
    const [revisions, proposals] = await Promise.all([
      client.from("freya_personality_revisions").select("revision, profile, summary, rollback_from, created_at")
        .eq("user_id", userId).order("revision", { ascending: false }).limit(20),
      client.from("freya_personality_proposals").select("id, category, description, confidence, evidence, origin, status, created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
    ]);
    if (revisions.error || proposals.error) return NextResponse.json({ error: "Cloud character storage is unavailable. Apply supabase/personality.sql." }, { status: 503 });
    const history = (revisions.data ?? []).map((row) => ({ ...row, profile: normalizeCharacterProfile(row.profile) }));
    return NextResponse.json({
      profile: history[0]?.profile ?? normalizeCharacterProfile(null),
      revisions: history,
      proposals: proposals.data ?? [],
      reflectionEnabled: (process.env.FREYA_REFLECTION_ENABLED || "true").toLowerCase() === "true",
    });
  } catch (error) { return fail(error); }
}

export async function POST(request: Request) {
  try {
    const { client, userId } = await authorizedClient(request);
    const data = await readBody(request);
    const action = data.action;

    if (action === "save") {
      const result = await appendRevision(client, data.profile, typeof data.summary === "string" ? data.summary : "Profile edited by the user.");
      return NextResponse.json(result);
    }

    if (action === "rollback") {
      const revision = data.revision;
      if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new ApiError("Choose a valid profile revision.", 400);
      const { data: saved, error } = await client.from("freya_personality_revisions")
        .select("profile").eq("user_id", userId).eq("revision", revision).maybeSingle();
      if (error || !saved) throw new ApiError("That profile revision is unavailable.", 404);
      const result = await appendRevision(client, saved.profile, `Rolled back to revision ${revision}.`, revision as number);
      return NextResponse.json(result);
    }

    if (action === "propose") {
      if ((process.env.FREYA_REFLECTION_ENABLED || "true").toLowerCase() !== "true") throw new ApiError("Bounded reflection is disabled by server settings.", 403);
      const dailyLimit = Math.max(0, Math.min(10, Number.parseInt(process.env.FREYA_REFLECTION_DAILY_LIMIT || "1", 10) || 1));
      if (dailyLimit === 0) throw new ApiError("Today's reflection budget is disabled.", 429);
      const category = data.category;
      const description = typeof data.description === "string" ? data.description.trim().slice(0, 240) : "";
      const origin = data.origin;
      const evidence = Array.isArray(data.evidence)
        ? data.evidence.filter((item): item is string => typeof item === "string").slice(0, 10).map((item) => item.slice(0, 300))
        : [];
      const topic = description.match(/^A recurring curiosity about (.+)$/i)?.[1]?.toLowerCase();
      if (category !== "interest" || !description || origin !== "inferred" || !topic || !REFLECTION_TOPIC_ALLOWLIST.has(topic)) {
        throw new ApiError("The preference proposal is invalid.", 400);
      }
      const confidence = typeof data.confidence === "number" && Number.isFinite(data.confidence) ? Math.min(1, Math.max(0, data.confidence)) : 0.35;
      const { data: proposal, error } = await client.rpc("create_freya_personality_proposal", {
        p_category: category,
        p_description: description,
        p_confidence: confidence,
        p_evidence: evidence,
        p_origin: origin,
        p_daily_limit: dailyLimit,
      });
      if (error) throw new ApiError(error.message.includes("Daily reflection budget") ? "Today's reflection budget has been used." : "Could not save the proposed reflection.", error.message.includes("Daily reflection budget") ? 429 : 503);
      return NextResponse.json({ proposal }, { status: 201 });
    }

    if (action === "review") {
      const id = typeof data.id === "string" && /^[0-9a-f-]{36}$/i.test(data.id) ? data.id : "";
      const decision = data.decision;
      if (!id || !["approved", "rejected", "disputed", "archived"].includes(String(decision))) throw new ApiError("The review action is invalid.", 400);
      const { data: proposal, error: readError } = await client.from("freya_personality_proposals")
        .select("id, status").eq("user_id", userId).eq("id", id).maybeSingle();
      if (readError || !proposal) throw new ApiError("That proposed reflection is unavailable.", 404);
      if (proposal.status !== "proposed") throw new ApiError("This proposal has already been reviewed.", 409);
      let profile: unknown;
      let revision: number | undefined;
      if (decision === "approved") {
        const { data: saved, error } = await client.rpc("approve_freya_personality_proposal", {
          p_proposal_id: id,
          p_default_profile: normalizeCharacterProfile(null),
        });
        if (error || !saved || typeof saved !== "object") throw new ApiError("Could not approve the proposed reflection.", 503);
        profile = normalizeCharacterProfile((saved as { profile?: unknown }).profile);
        revision = Number((saved as { revision?: unknown }).revision);
      } else {
        const { error } = await client.from("freya_personality_proposals").update({ status: decision, updated_at: new Date().toISOString() })
          .eq("user_id", userId).eq("id", id).eq("status", "proposed");
        if (error) throw new ApiError("Could not save the proposal review.", 503);
      }
      return NextResponse.json({ status: decision, profile, revision });
    }

    throw new ApiError("Unsupported character profile action.", 400);
  } catch (error) { return fail(error); }
}
