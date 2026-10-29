export type ReflectionTurn = { role: "user" | "assistant"; content: string };
export type ReflectionCandidate = {
  category: "interest";
  description: string;
  confidence: number;
  origin: "inferred";
  evidence: string[];
};

// A low-risk allowlist prevents extracting personal, health, financial, or other
// sensitive topics. Only aggregate counts are saved; message excerpts are not.
const TOPICS = [
  ["music", /\b(music|song|songs|album|albums|trip-hop|jazz)\b/i],
  ["visual art", /\b(art|painting|paintings|illustration|sculpture)\b/i],
  ["design", /\b(design|typography|color theory|interface design)\b/i],
  ["mythology", /\b(mythology|myth|myths|folklore)\b/i],
  ["language", /\b(language|linguistics|etymology|translation)\b/i],
  ["history", /\b(history|historical|archaeology)\b/i],
  ["philosophy", /\b(philosophy|ethics|epistemology)\b/i],
  ["astronomy", /\b(astronomy|space|planet|planets|stars|cosmos)\b/i],
  ["literature", /\b(literature|novel|novels|poetry|poem|fiction)\b/i],
  ["architecture", /\b(architecture|architectural|buildings)\b/i],
  ["nature", /\b(nature|wildlife|forest|forests|ecology)\b/i],
  ["science", /\b(science|physics|chemistry|biology|mathematics)\b/i],
  ["games", /\b(video games|game design|games|gaming)\b/i],
  ["film", /\b(film|films|cinema|movie|movies)\b/i],
] as const;

export function deriveReflectionCandidates(messages: ReflectionTurn[]): ReflectionCandidate[] {
  const userTurns = messages.filter((message) => message.role === "user").slice(-24);
  return TOPICS.flatMap(([topic, pattern]) => {
    const count = userTurns.filter(({ content }) => pattern.test(content)).length;
    if (count < 3) return [];
    return [{
      category: "interest" as const,
      description: `A recurring curiosity about ${topic}`,
      confidence: Math.min(0.65, 0.35 + count * 0.06),
      origin: "inferred" as const,
      evidence: [`${count} separate user turns mentioned ${topic}; analyzed locally from this conversation.`],
    }];
  }).slice(0, 3);
}
