/**
 * FREYA's state with a signed-in account, kept in Supabase (supabase/freya-state.sql) so it
 * follows them to any browser: her mood, her read on them, and where the two of them are. Her
 * memories and personality already live there (memories, freya_personality_*).
 *
 * The browser reads and writes its own row directly; row-level security keeps every account to its
 * own. Whichever copy was saved last wins. If the table hasn't been created yet, syncing stops for
 * the session and everything keeps working from this browser, as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeMood, type MoodState } from "@/lib/mood";
import { normalizeUserMood, type UserMood } from "@/lib/user-mood";
import { normalizeBond, type Bond } from "@/lib/relationship";

export type SharedState = { mood: MoodState | null; userMood: UserMood | null; bond: Bond | null };

const TABLE = "freya_state";

/** "The table isn't there": PostgREST's missing-relation codes. */
function missing(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || /freya_state/.test(error.message ?? "") && /does not exist|could not find/i.test(error.message ?? "")));
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.info("FREYA: run supabase/freya-state.sql in Supabase to keep her mood and your relationship with your account. Until then they stay in this browser.");
}

export async function pullState(client: SupabaseClient, userId: string): Promise<SharedState | null | "missing"> {
  const { data, error } = await client.from(TABLE).select("mood, user_mood, bond").eq("user_id", userId).maybeSingle();
  if (missing(error)) { warnOnce(); return "missing"; }
  if (error || !data) return null;
  return { mood: normalizeMood(data.mood), userMood: normalizeUserMood(data.user_mood), bond: normalizeBond(data.bond) };
}

export async function pushState(client: SupabaseClient, userId: string, state: SharedState): Promise<boolean | "missing"> {
  const { error } = await client.from(TABLE).upsert({
    user_id: userId,
    mood: state.mood,
    user_mood: state.userMood,
    bond: state.bond,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (missing(error)) { warnOnce(); return "missing"; }
  return !error;
}

/**
 * Which copy of each part to keep. More history wins first: a copy that has been through more
 * messages is the real one, and a fresh, never-used copy (a new browser, a new sign-in, the first
 * load after a restart) never replaces it, however new its timestamp. Same history: the newer.
 * That fresh copy winning is what sent her back to "stranger" on every new login.
 */
export function newerState(local: SharedState, remote: SharedState): Partial<SharedState> {
  const out: Partial<SharedState> = {};
  if (remote.bond && (!local.bond || remote.bond.messages > local.bond.messages || (remote.bond.messages === local.bond.messages && remote.bond.updatedAt > local.bond.updatedAt))) out.bond = remote.bond;
  if (remote.mood && (!local.mood || remote.mood.talked > local.mood.talked || (remote.mood.talked === local.mood.talked && remote.mood.lastUserAt > local.mood.lastUserAt))) out.mood = remote.mood;
  if (remote.userMood && (!local.userMood || remote.userMood.since > local.userMood.since)) out.userMood = remote.userMood;
  return out;
}
