/**
 * Guesses the language of a reply so speech playback uses a matching voice.
 *
 * Script detection first: a block of Devanagari, Arabic, Han, Kana, Hangul, Cyrillic, Greek,
 * Hebrew or Thai is decisive on its own. Latin-script languages share an alphabet, so those
 * fall back to scoring common function words, which are short, frequent and rarely ambiguous.
 *
 * This is a heuristic for choosing a TTS voice, not a classifier. When nothing scores clearly
 * it returns null and the caller keeps the browser default.
 */

/** Unicode ranges that identify a language (or a small family) outright. */
const SCRIPTS: { lang: string; pattern: RegExp }[] = [
  { lang: "hi-IN", pattern: /[ऀ-ॿ]/ },
  { lang: "bn-IN", pattern: /[ঀ-৿]/ },
  { lang: "ta-IN", pattern: /[஀-௿]/ },
  { lang: "te-IN", pattern: /[ఀ-౿]/ },
  { lang: "gu-IN", pattern: /[઀-૿]/ },
  { lang: "kn-IN", pattern: /[ಀ-೿]/ },
  { lang: "ml-IN", pattern: /[ഀ-ൿ]/ },
  { lang: "pa-IN", pattern: /[਀-੿]/ },
  { lang: "th-TH", pattern: /[฀-๿]/ },
  { lang: "he-IL", pattern: /[֐-׿]/ },
  { lang: "ar-SA", pattern: /[؀-ۿ]/ },
  { lang: "el-GR", pattern: /[Ͱ-Ͽ]/ },
  { lang: "ru-RU", pattern: /[Ѐ-ӿ]/ },
  { lang: "ko-KR", pattern: /[가-힯ᄀ-ᇿ]/ },
  // Kana before Han: Japanese text mixes both, Chinese uses Han alone.
  { lang: "ja-JP", pattern: /[぀-ゟ゠-ヿ]/ },
  { lang: "zh-CN", pattern: /[一-鿿]/ },
];

/** Function words that are frequent in one Latin-script language and rare in the others. */
const LATIN_MARKERS: { lang: string; words: string[] }[] = [
  { lang: "es-ES", words: ["el", "la", "los", "las", "que", "de", "y", "es", "en", "por", "para", "con", "una", "pero", "como", "más", "este", "está", "muy", "cuando"] },
  { lang: "fr-FR", words: ["le", "la", "les", "des", "et", "est", "une", "dans", "pour", "que", "qui", "avec", "pas", "sur", "vous", "nous", "plus", "mais", "comme", "être"] },
  { lang: "de-DE", words: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "auf", "für", "von", "sich", "dem", "den", "auch", "wird", "aber", "wenn", "sind"] },
  { lang: "it-IT", words: ["il", "la", "di", "che", "non", "per", "una", "sono", "con", "come", "anche", "più", "questo", "nel", "alla", "dei", "sua", "ma", "quando", "essere"] },
  { lang: "pt-BR", words: ["o", "a", "de", "que", "não", "uma", "para", "com", "por", "mais", "como", "isso", "você", "está", "são", "mas", "muito", "quando", "também", "sobre"] },
  { lang: "nl-NL", words: ["de", "het", "een", "van", "en", "is", "dat", "niet", "voor", "met", "op", "aan", "te", "zijn", "maar", "ook", "als", "worden", "deze", "naar"] },
  { lang: "pl-PL", words: ["nie", "jest", "się", "jak", "tak", "czy", "ale", "tego", "tym", "oraz", "przez", "jego", "może", "być", "bardzo", "jeśli", "który", "wszystko", "dla", "tylko"] },
  { lang: "tr-TR", words: ["bir", "bu", "ve", "için", "ile", "daha", "çok", "olarak", "gibi", "ama", "ne", "var", "değil", "kadar", "sonra", "her", "şey", "oldu", "ben", "sen"] },
  { lang: "id-ID", words: ["yang", "dan", "di", "itu", "dengan", "untuk", "tidak", "ini", "dari", "akan", "pada", "kamu", "saya", "adalah", "bisa", "ada", "juga", "sudah", "karena", "atau"] },
  { lang: "vi-VN", words: ["của", "và", "là", "không", "có", "được", "những", "trong", "người", "một", "cho", "với", "này", "để", "khi", "đã", "các", "bạn", "tôi", "rằng"] },
  { lang: "en-US", words: ["the", "and", "is", "to", "of", "that", "it", "you", "for", "with", "this", "but", "not", "are", "what", "your", "have", "just", "like", "about"] },
];

/** Strips markdown, code and URLs so detection scores prose, not syntax. */
function proseOnly(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_~#>|[\]()]/g, " ");
}

/**
 * Returns a BCP-47 tag, or null when nothing scores clearly enough to override the default.
 */
export function detectLanguage(text: string): string | null {
  const prose = proseOnly(text);
  if (!prose.trim()) return null;

  // A non-Latin script settles it: count characters so a stray glyph cannot decide.
  const letters = prose.replace(/[^\p{L}]/gu, "").length;
  if (letters) {
    for (const { lang, pattern } of SCRIPTS) {
      const global = new RegExp(pattern.source, "gu");
      const hits = (prose.match(global) ?? []).length;
      if (hits / letters > 0.2) return lang;
    }
  }

  const words = prose.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 4) return null;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);

  let best = "";
  let bestScore = 0;
  let runnerUp = 0;
  for (const { lang, words: markers } of LATIN_MARKERS) {
    let score = 0;
    for (const marker of markers) score += counts.get(marker) ?? 0;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  // Require both a real signal and a clear margin: shared words like "de" and "la" otherwise
  // make Spanish, French and Portuguese trade places on a single sentence.
  const density = bestScore / words.length;
  if (bestScore < 2 || density < 0.04) return null;
  if (bestScore < runnerUp * 1.4) return null;
  return best;
}

/** Picks the closest installed voice for a language tag. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const want = lang.toLowerCase();
  const base = want.split("-")[0];
  return voices.find((voice) => voice.lang?.toLowerCase().replace("_", "-") === want)
    ?? voices.find((voice) => voice.lang?.toLowerCase().startsWith(`${base}-`))
    ?? voices.find((voice) => voice.lang?.toLowerCase() === base)
    ?? null;
}
