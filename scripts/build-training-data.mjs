// Builds training/freya-train.jsonl, the LoRA fine-tuning dataset, from the shared examples.
//
//   npm run train:data
//
// Each line is one conversation in the chat "messages" format that Unsloth, TRL and most
// trainers accept: the app's own system prompt, then the example turns. Training on the same
// system prompt the app sends teaches the model to stay FREYA under it, rather than learning a
// second, different persona. Grow training/freya-examples.json for a stronger result; a few
// hundred varied conversations is a sensible target.
import { readFile, writeFile } from "node:fs/promises";
import { buildLocalSystemPrompt } from "../lib/personality.ts";
import { createDefaultCharacterProfile } from "../lib/character-profile.ts";

const examples = JSON.parse(await readFile(new URL("../training/freya-examples.json", import.meta.url), "utf8"));
const system = buildLocalSystemPrompt([], "adaptive", createDefaultCharacterProfile(), true);

const lines = examples.conversations.map((conversation) => {
  const roles = conversation.messages.map((message) => message.role);
  if (roles.at(-1) !== "assistant" || roles.some((role, index) => role !== (index % 2 ? "assistant" : "user"))) {
    throw new Error(`Conversation must alternate user/assistant and end with FREYA: ${JSON.stringify(conversation.messages[0])}`);
  }
  return JSON.stringify({ messages: [{ role: "system", content: system }, ...conversation.messages] });
});

await writeFile(new URL("../training/freya-train.jsonl", import.meta.url), `${lines.join("\n")}\n`);
console.log(`training/freya-train.jsonl written: ${lines.length} conversations.`);
