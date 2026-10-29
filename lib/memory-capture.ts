import { containsSensitiveCredential } from "@/lib/sensitive-data";

const PRIVATE_TOPICS = /\b(?:medical|diagnos(?:is|ed)|medication|therapy|trauma|sexual|pregnan|politic|religio|password|passcode|secret|api key|address|phone|email|bank|credit card|ssn|passport|immigration|salary|debt|legal case|my child|my partner|my spouse)\b/i;
const PERSONAL_CONTACT = /\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[\d\s().-]{8,}\d)\b/i;

/** Extract only an explicit, low-risk first-person preference; never infer from silence. */
export function captureExplicitPreference(text: string): string | null {
  const match = text.match(/\b(?:i prefer|i like|i love|i enjoy)\s+([^.!?\n]{2,180})/i);
  const detail = match?.[1]?.trim().replace(/["'`]+$/g, "");
  if (!detail || containsSensitiveCredential(text) || PRIVATE_TOPICS.test(text) || PERSONAL_CONTACT.test(text)) return null;
  return `User preference: ${match?.[0]?.slice(0, 200).trim()}`;
}
