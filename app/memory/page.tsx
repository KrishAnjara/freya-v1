
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  addMemory,
  deleteAllMemories,
  deleteMemory,
  getMemories,
  signIn,
  signOut,
  signUp,
  updateMemory,
  type Memory,
} from "@/lib/memory";

export default function MemoryPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    if (!supabase) {
      setMessage("Cloud memory is not configured. Add the Supabase URL and anon key.");
      return;
    }
    const { data } = await supabase.auth.getUser();

    setUserEmail(data.user?.email ?? null);

    if (data.user) {
      setMemories(await getMemories());
    } else {
      setMemories([]);
    }
  }

  useEffect(() => {
    let active = true;
    const client = supabase;

    if (!client) {
      setMessage("Cloud memory is not configured. Add the Supabase URL and anon key.");
      return () => { active = false; };
    }

    async function load() {
      if (!client) return;
      try {
        const { data } = await client.auth.getUser();
        if (!active) return;

        setUserEmail(data.user?.email ?? null);

        if (data.user) {
          const items = await getMemories();
          if (active) setMemories(items);
        }
      } catch (err) {
        if (active) {
          setMessage(
            err instanceof Error ? err.message : "Could not load memory."
          );
        }
      }
    }

    void load();

    const { data: listener } = client.auth.onAuthStateChange(
      () => {
        // Defer database work until after the auth callback.
        window.setTimeout(() => {
          if (active) void load();
        }, 0);
      }
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");

    try {
      await action();
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : "Something went wrong."
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveMemory() {
    const value = content.trim();
    if (!value) return;

    if (editingId) {
      await updateMemory(editingId, value);
    } else {
      await addMemory(value);
    }

    setContent("");
    setEditingId(null);
    setMemories(await getMemories());
    setMessage("Memory saved.");
  }

  if (!supabase) {
    return (
      <main className="memory-page space-y-4">
        <Link className="memory-back" href="/">← Back to chat</Link>
        <h1 className="text-2xl font-bold">FREYA Memory</h1>
        <p role="status">Cloud memory is not configured. Add the Supabase URL and anon key to enable account memory.</p>
      </main>
    );
  }

  if (!userEmail) {
    return (
      <main className="memory-page space-y-4">
        <Link className="memory-back" href="/">← Back to chat</Link>
        <h1 className="text-2xl font-bold">FREYA Memory</h1>
        <p>Sign in to save preferences across conversations.</p>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await signIn(email, password);
              await refresh();
            });
          }}
        >
          <input
            className="w-full rounded border p-3"
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <input
            className="w-full rounded border p-3"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <button
            className="rounded bg-black px-4 py-2 text-white"
            disabled={busy}
          >
            Sign in
          </button>

          <button
            className="ml-2 rounded border px-4 py-2"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await signUp(email, password);

                if (!result.session) {
                  setMessage(
                    "Account created. Check your email to confirm, then sign in."
                  );
                } else {
                  await refresh();
                }
              })
            }
          >
            Create account
          </button>
        </form>

        {message && <p role="status">{message}</p>}
      </main>
    );
  }

  return (
    <main className="memory-page space-y-5">
      <Link className="memory-back" href="/">← Back to chat</Link>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">FREYA Memory</h1>
          <p className="text-sm text-gray-500">{userEmail}</p>
        </div>

        <button
          className="rounded border px-3 py-2"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await signOut();
              setMemories([]);
              setUserEmail(null);
            })
          }
        >
          Sign out
        </button>
      </header>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(saveMemory);
        }}
      >
        <textarea
          className="w-full rounded border p-3"
          rows={3}
          maxLength={2000}
          placeholder="Example: I prefer short, casual answers."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
        />

        <button
          className="rounded bg-black px-4 py-2 text-white"
          disabled={busy}
        >
          {editingId ? "Update memory" : "Save memory"}
        </button>

        {editingId && (
          <button
            className="ml-2 rounded border px-4 py-2"
            type="button"
            onClick={() => {
              setEditingId(null);
              setContent("");
            }}
          >
            Cancel edit
          </button>
        )}
      </form>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Saved memories ({memories.length})
        </h2>

        {memories.map((memory) => (
          <article key={memory.id} className="rounded border p-3">
            <p className="whitespace-pre-wrap">{memory.content}</p>

            <div className="mt-3 flex gap-3 text-sm">
              <button
                className="underline"
                onClick={() => {
                  setEditingId(memory.id);
                  setContent(memory.content);
                }}
              >
                Edit
              </button>

              <button
                className="text-red-600 underline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await deleteMemory(memory.id);
                    setMemories(await getMemories());
                    setMessage("Memory deleted.");
                  })
                }
              >
                Delete
              </button>
            </div>
          </article>
        ))}

        {memories.length > 0 && (
          <button
            className="rounded border border-red-500 px-3 py-2 text-red-600"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Delete all saved memories?")) return;

              void run(async () => {
                await deleteAllMemories();
                setMemories([]);
                setMessage("All memories deleted.");
              });
            }}
          >
            Delete all memories
          </button>
        )}
      </section>

      {message && <p role="status">{message}</p>}
    </main>
  );
}
