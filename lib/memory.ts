import { supabase } from "./supabase";
import { containsSensitiveCredential } from "@/lib/sensitive-data";

function requireSupabase() {
  if (!supabase) {
    throw new Error("Cloud memory is not configured. Add the Supabase URL and anon key.");
  }
  return supabase;
}

export type Memory = {
  id: string;
  content: string;
  created_at: string;
  updated_at: string;
};

export async function signUp(email: string, password: string) {
  const { data, error } = await requireSupabase().auth.signUp({
    email,
    password,
  });

  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string) {
  const { data, error } = await requireSupabase().auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw error;
}

export async function getMemories(): Promise<Memory[]> {
  const { data, error } = await requireSupabase()
    .from("memories")
    .select("id, content, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function addMemory(content: string) {
  const cleanContent = content.trim();

  if (!cleanContent || cleanContent.length > 2000) {
    throw new Error("Memory must contain 1–2000 characters.");
  }
  if (containsSensitiveCredential(cleanContent)) throw new Error("Credentials and secrets cannot be saved as memories.");

  const { data: authData, error: authError } =
    await requireSupabase().auth.getUser();

  if (authError) throw authError;

  const user = authData.user;

  if (!user) {
    throw new Error("Sign in before saving memories.");
  }

  const { data, error } = await requireSupabase()
    .from("memories")
    .insert({
      user_id: user.id,
      content: cleanContent,
    })
    .select("id, content, created_at, updated_at")
    .single();

  if (error) throw error;
  return data as Memory;
}

export async function updateMemory(
  id: string,
  content: string
) {
  const cleanContent = content.trim();

  if (!cleanContent || cleanContent.length > 2000) {
    throw new Error("Memory must contain 1–2000 characters.");
  }
  if (containsSensitiveCredential(cleanContent)) throw new Error("Credentials and secrets cannot be saved as memories.");

  const { data, error } = await requireSupabase()
    .from("memories")
    .update({
      content: cleanContent,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, content, created_at, updated_at")
    .single();

  if (error) throw error;
  return data as Memory;
}

export async function deleteMemory(id: string) {
  const { error } = await requireSupabase()
    .from("memories")
    .delete()
    .eq("id", id);

  if (error) throw error;
}

export async function deleteAllMemories() {
  const { data: authData, error: authError } =
    await requireSupabase().auth.getUser();

  if (authError) throw authError;

  if (!authData.user) {
    throw new Error("Sign in before deleting memories.");
  }

  const { error } = await requireSupabase()
    .from("memories")
    .delete()
    .eq("user_id", authData.user.id);

  if (error) throw error;
}
