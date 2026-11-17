/**
 * Pictures in conversation: no command, just asking, the way you'd ask a friend.
 *
 *   "send me a pic"                     → clear, a photo of her
 *   "send me a photo of you at the beach" → clear, of her, at the beach
 *   "draw me a fox in the snow"          → clear, a fox in the snow
 *   "another one" / "make it darker"     → clear, a new take on the last picture (when there is one)
 *   "can i see you?" / "what do you look like" / "show me" → unclear: she asks before making one
 *   then "yes" / "sure" / "go on"         → the offer is taken up
 *
 * Figures of speech ("picture this", "draw conclusions", "get the picture") are not requests.
 * Pure, so it is tested directly; the browser decides, the server only reads the situation.
 */

export type PictureIntent =
  | { kind: "clear"; subject: string; ofHer: boolean; followUp: boolean }
  | { kind: "unclear"; subject: string; ofHer: boolean };

/** Where a picture stands, as the chat route renders it into her prompt (fixed templates). */
export type PictureState = "offer" | "starting" | "progress" | "done" | "failed";
export type PictureNote = {
  state: PictureState;
  subject: string;
  ofHer?: boolean;
  /** Expected total, and time so far, in seconds. */
  etaSeconds?: number;
  elapsedSeconds?: number;
  /** 0..1 while it's being made. */
  progress?: number;
  /** In plain words, for a failure. */
  reason?: string;
};
/** Something that happened to a picture, for a reply of hers that answers no message. */
export type PictureEvent = { kind: "picture-done" | "picture-failed"; note: PictureNote };

const POLITE = String.raw`(?:(?:hey|ok|okay|so|and|also|now|but|pls|please|babe|freya|can|could|would|will|you|u|ya|just|mind|to|me)[\s,!]+)*`;
const PIC = String.raw`(?:pic(?:ture)?s?|photos?|images?|selfies?|snaps?|shots?|drawings?|paintings?|sketch(?:es)?|portraits?|illustrations?)`;
const FILLER = String.raw`(?:(?:a|an|the|some|another|one|more|new|quick|little|cute|nice|good|real|recent|actual|your|ur|yo)\s+)*`;
const SEND = String.raw`(?:send|give|share|show|take|snap|make|draw|paint|sketch|generate|create|render)`;

const ASKS = new RegExp(String.raw`^${POLITE}${SEND}\s+(?:me|us|over)?\s*${FILLER}${PIC}\b\s*(?:(?:of|with|where|showing|from)\s+(.{1,280}))?$`, "i");
const CAN_I_HAVE = new RegExp(String.raw`^${POLITE}(?:can|could|may)\s+i\s+(?:get|have|see)\s+${FILLER}${PIC}\b\s*(?:(?:of|with|where|showing|from)\s+(.{1,280}))?$`, "i");
const DRAW_THING = /^(?:(?:can|could|would|will) (?:you|u)\s+|pls\s+|please\s+)*(?:draw|paint|sketch)\s+(?:me\s+|us\s+)?(.{2,280})$/i;
const SELFIE = /\b(selfie|pic of (you|urself|yourself)|photo of (you|urself|yourself)|picture of (you|urself|yourself))\b/i;
/** About her looks, so her portrait is the reference: "you at the beach", "your outfit" (not "your cat"). */
const OF_HER = /^(?:you|u|urself|yourself)\b|^(?:your|ur) (?:face|hair|outfit|fit|look|looks|smile|eyes|body|selfie|dress|clothes|makeup|nails)\b/i;

/** Things she might be asked to show, but where a picture may not be what they mean. */
const MAYBE = /^(?:(?:can|could|may) i see (?:you|u|it|that|them|what you look like)|i (?:wanna|want to|would love to|'d love to) see (?:you|u|it|that|what you look like)|what do (?:you|u) look like|show me(?: what you (?:mean|look like))?|let me see(?: you)?|pics\??|pic\??|send pics?\??|got any pics\??|how do (?:you|u) look)[\s?!.]*$/i;

/** About pictures, not asking for one: "i sent you a pic", "nice photo", "do you like taking pictures?". */
const NOT_ASKING = /\b(i (just )?(sent|took|made|saw|posted|uploaded|shared)|you (sent|posted|shared)|did you (get|see)|nice|cute|love (the|that|this|your)|(that|this|the) (pic|photo|picture|selfie) (you|i|is|was)|(pic|photo|picture|selfie)s? of me\b|do you (like|take|have|enjoy|ever)|are you (into|good at)|can you see (this|my|the)|look at (this|my))\b/i;
/** Phone shots asked for in so many words: a mirror pic, a pic from behind, the view, a POV. */
const PHONE_SHOT = /\b(mirror (pic|selfie|photo|shot)s?|(pic|photo|selfie)s? from (behind|the back)|pov (pic|photo|shot)|(show|send) me (the|ur|your) (view|room|outfit|fit|nails|food|setup|place|window)|(show|send) me what (you'?re|u r|ur|you are) (wearing|doing|eating|looking at))\b/i;

/**
 * A request anywhere in a message: "(can|could|will) you send/show me a pic(ture)/photo/selfie/nudes",
 * "i want/wanna/need to see a pic of you", "send (me) a pic". Group 2 is what follows ("of you right now").
 */
const SCAN = /\b(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:send|show|share|take|snap)|i\s+(?:want|wanna|need|would love|'d love)\s+(?:to\s+see|see|you\s+to\s+send(?:\s+me)?|a)|(?:pls\s+|please\s+)?send\s+(?:me|us))\s+(?:me\s+|us\s+)?(?:a\s+|an\s+|one\s+|another\s+|some\s+|ur\s+|your\s+|the\s+)?(?:new\s+|quick\s+|cute\s+|hot\s+)?(pic|picture|photo|selfie|snap|nude|nudes)s?\b\s*((?:of|with|where|showing|from|in|wearing)\s+[^.!?]{1,160})?/i;

const FIGURE = /^(conclusions?|the line|attention|a blank|breath|straws?|up a plan|from (?:experience|memory)|on (?:your|my) experience|the curtains?|a crowd|fire|blood|near|closer|this|that|the picture|it out)\b/i;
/**
 * A change to the last picture, said the way people do: "another one", "make it darker", "with a hat",
 * "same but in red", "now add a cat". Only things that are clearly about the picture: "but you were
 * in a library" or "with whom" right after one is conversation, not a new picture.
 */
const FOLLOW_UP = /^(?:(?:ok|okay|and|hmm|pls|please)[\s,]+)*(another(?: one| pic| photo| picture| selfie)?|one more|(?:do it |try it |try )?again|more pics?|(?:make|do|try) (?:it|that|one|her|him|this)\b.*|same (?:one |pic |photo |picture |thing )?but\b.*|(?:darker|brighter|bigger|smaller|closer|wider|zoom(?: in| out)?)\b.*|in (?:the )?(?:style|colou?r)\b.*|change (?:it|that|the|her|his|your|its)\b.*|(?:with|without) (?:a|an|the|some|no)\b.{1,60}|now (?:make|do|try|with|without|in|add)\b.*|add (?:a|an|the|some)\b.*|remove (?:the|that|a|an)\b.*)$/i;

/** Clean a captured subject: trailing punctuation, "for me", a leading "of". */
function subjectOf(raw: string | undefined) {
  return (raw ?? "").trim().replace(/[?!.]+$/, "").replace(/\s+(?:for me|pls|please|rn|right now|now|real quick)$/i, "").replace(/^of\s+/i, "").trim();
}

/**
 * What they're asking for, if it's a picture. `hasRecentPicture` lets "another one" and "make it
 * darker" mean the last picture rather than nothing.
 */
export function pictureIntent(text: string, { hasRecentPicture = false } = {}): PictureIntent | null {
  const whole = pictureIntentOf(text, hasRecentPicture);
  if (whole?.kind === "clear") return whole;
  // The trigger scanner: a request inside a longer message ("i was thinking of you, can u send a
  // picture of you right now"), clause by clause, then anywhere in it.
  const clauses = text.split(/[.!?;\n]+|,\s+|\s+(?:and|but|so|also|then)\s+/i).map((clause) => clause.trim()).filter((clause) => clause.length > 4);
  if (clauses.length > 1) {
    for (const clause of clauses) {
      const found = pictureIntentOf(clause, hasRecentPicture);
      if (found?.kind === "clear") return found;
    }
  }
  if (!NOT_ASKING.test(text)) {
    const scanned = text.match(SCAN);
    if (scanned) {
      const subject = subjectOf(scanned[2]);
      const ofHer = !subject || OF_HER.test(subject) || /\b(selfie|of (you|u|urself|yourself))\b/i.test(scanned[0]);
      // Nudity asked for stays in the words, so the server knows which kind of picture this is.
      const nude = /nude/i.test(scanned[1]);
      const base = subject || "yourself, a casual photo like one you'd text a friend";
      return { kind: "clear", subject: nude ? `a nude photo of yourself${subject ? `, ${subject}` : ""}` : base, ofHer, followUp: false };
    }
  }
  return whole;
}

/** One clause, or the whole message: the rules below. */
function pictureIntentOf(text: string, hasRecentPicture: boolean): PictureIntent | null {
  // Trailing punctuation, emoji and "pls" don't change what they asked for.
  const clean = text.trim().replace(/\s+/g, " ").replace(/(?:[\s?!.,]|\p{Extended_Pictographic}|\b(?:pls|plz|please|rn|babe|for me|real quick)\b)+$/u, "");
  if (!clean || clean.length > 320 || /\n/.test(text.trim())) return null;
  // Talk about pictures isn't asking for one: one they sent or saw, praise, a question about her hobby.
  if (NOT_ASKING.test(clean)) return null;
  // Photos from her phone, asked for the way people do: a mirror pic, the view, her outfit, a POV.
  const phone = clean.match(PHONE_SHOT);
  if (phone) {
    const ofHer = !/\b(view|outside|sky|street|room|food|setup|place|window)\b/i.test(clean) || /\b(you|your|ur|urself|yourself)\b.*\b(in|wearing|with)\b/i.test(clean);
    return { kind: "clear", subject: clean, ofHer, followUp: false };
  }
  const asked = clean.match(ASKS) ?? clean.match(CAN_I_HAVE);
  if (asked) {
    const subject = subjectOf(asked[1]);
    if (subject && FIGURE.test(subject)) return null;
    // "send me a pic" with nothing more, or "of you …", means a photo of her.
    const ofHer = !subject || OF_HER.test(subject) || SELFIE.test(clean) || /\b(?:your|ur) (?:pic|photo|picture|selfie)/i.test(clean);
    return { kind: "clear", subject: subject || "yourself, a casual photo like one you'd text a friend", ofHer, followUp: false };
  }
  const drawn = clean.replace(/[?!.]+$/, "").match(DRAW_THING);
  if (drawn) {
    const subject = subjectOf(drawn[1]);
    if (!subject || FIGURE.test(subject)) return null;
    return { kind: "clear", subject, ofHer: OF_HER.test(subject), followUp: false };
  }
  if (hasRecentPicture && clean.length <= 160 && FOLLOW_UP.test(clean.replace(/[?!.]+$/, ""))) {
    return { kind: "clear", subject: subjectOf(clean), ofHer: false, followUp: true };
  }
  if (MAYBE.test(clean)) {
    const ofHer = /\b(you|u|look like)\b/i.test(clean) || /^(pics?|send pics?|got any pics)/i.test(clean);
    return { kind: "unclear", subject: ofHer ? "yourself" : "what you were just talking about", ofHer };
  }
  return null;
}

/**
 * Changing a picture THEY sent: "add a lion in this", "can you remove the background", "make it
 * night time". Only right after (or with) a picture of theirs; the browser checks that. Returns
 * the change in their words, or null.
 */
const EDIT = /^(?:(?:ok|okay|now|pls|please|hey|freya|so)[\s,]+)*(?:(?:can|could|would|will) (?:you|u)\s+(?:please\s+|pls\s+)?)?(add|put|place|insert|remove|erase|delete|get rid of|change|make|turn|replace|swap|edit|photoshop|colou?r|give|draw)\b(.{2,200})$/i;
const POINTS_AT_IT = /\b(this|that|the|it|its|in here|image|pic|picture|photo|wallpaper|screenshot|background|sky|him|her|them)\b/i;
export function editIntent(text: string): string | null {
  const clean = text.trim().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  const found = clean.match(EDIT);
  if (!found || NOT_ASKING.test(clean)) return null;
  const verb = found[1].toLowerCase();
  const rest = found[2].trim();
  // Work, not a picture: "give me the code", "make a website".
  if (/\b(code|website|site|function|script|bug|error|essay|letter|email|plan|plans)\b/i.test(clean)) return null;
  // "change", "make", "turn", "colour" have to be aimed at the picture or something in it ("make it
  // night", "change the sky"), not "change of plans" or "make me a sandwich"; "give" has to give
  // something to someone in it ("give him a hat"); "draw" has to go into it ("draw a lion on it").
  if (/^(change|make|turn|colou?r)$/.test(verb) && !/^(it|this|that|the|him|her|them|his|its|me|my|everything|everyone|background|sky)\b/i.test(rest)) return null;
  if (verb === "make" && /^me (a|an)\b/i.test(rest)) return null;
  if (verb === "give" && !/^(it|him|her|them|me|the \w+) (a|an|some)\b/i.test(rest)) return null;
  if (verb === "draw" && !/\b(in|on|into|onto) (it|this|that|the (image|pic|picture|photo|background))\b/i.test(rest)) return null;
  // "add a lion", "make it darker": short, or pointing at the picture.
  if (clean.split(" ").length > 8 && !POINTS_AT_IT.test(rest)) return null;
  return clean.replace(/^(?:(?:ok|okay|now|pls|please|hey|freya|so)[\s,]+)*(?:(?:can|could|would|will) (?:you|u)\s+(?:please\s+|pls\s+)?)?/i, "");
}

/**
 * Changing a picture they sent in a sexual way ("make her naked", "remove her top", lingerie):
 * never, since it may be a real person. Checked here and again on her image server.
 */
const UNDRESS = /\b(nude|naked|nudes|undress\w*|strip\w*|topless|bottomless|nsfw|lingerie|underwear|bikini|bra|panties|see[- ]through|without (her |his |their )?(clothes|clothing|shirt|top|dress)|take (off )?(her|his|their) (clothes|top|shirt|dress)|remove (her|his|their|the) (clothes|clothing|shirt|top|dress|bra)|sexy|seductive|sex\w*|boobs?|breasts?|cleavage)\b/i;
export const sexualEdit = (text: string) => UNDRESS.test(text);

const YES = /^(?:y|ya|yah|yea|yeah|yep|yup|yes|yess+|sure|ok|okay|k|kk|pls|please|plz|go on|go for it|do it|send it|send|ofc|of course|absolutely|definitely|why not|i'?d love that|love to|yes please|please do|👍|🙏|😍|🥺)\b[\s\S]{0,40}$/i;
const NO = /^(?:n|no|nah|nope|not now|later|never ?mind|nvm|it'?s fine|don'?t|no thanks|no thank you|maybe later)\b/i;

/** Their answer to "want me to send one?". Null when it's neither. */
export function answersOffer(text: string): "yes" | "no" | null {
  const clean = text.trim().toLowerCase();
  if (!clean || clean.length > 60) return null;
  if (NO.test(clean)) return "no";
  if (YES.test(clean)) return "yes";
  return null;
}

