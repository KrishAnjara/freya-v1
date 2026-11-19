# How FREYA works

Five things in this guide:

- what happens when you send a message
- what happens when you ask for a picture
- how her feelings work
- every rule she follows
- how to check it all yourself

## One message, start to finish

1. **You send it.** The browser marks that you're here: she's glad if you've been gone a while, and groggy if it's 5 am. Then it sends the chat to `/api/chat`. Your chat is saved only in Supabase, never in the browser.
2. **Sign-in.** Only the owner's account gets in (`ownerOnly`), from one browser at a time (`oneSession`).
3. **Fixed answers, no model.** A few things never reach a model:
   - a sincere "am I talking to a real person?"
   - anything romantic or sexual involving a minor
   - how-to help with a real crime
   - the time
   - news when search is off
4. **Her heart is brought up to now** (`lib/heart.ts`). Starting point: the copy saved with your account, or the browser's, whichever has more history. Since then:
   - feelings have faded
   - she has missed you
   - her own day has moved on
5. **She reads your message** (`lib/mood-appraisal.ts`). A model says how your message changes what she feels. It also gives:
   - a private thought
   - what she wants to do next
   - what happened (an insult, an apology, news)
   - anything that will stay on her mind
   - how you seem

   Who reads it:
   - a normal turn: a fast cloud model (Groq, then Gemini)
   - an intimate turn: only her own server
   - Local-only: nothing reads it

   No word lists are involved. If the reading fails, only time and her day move her.

   The same reading decides **how long her reply should be**: a "good morning" gets a quick text, while help, an argument or something you're upset about gets a proper answer.

   Two more things happen at the same time, not after:
   - notes for a factual question are gathered
   - **recall**: if you mention something that isn't in the last 50 turns she can see, she searches everything you two have said for it, deleted messages included, and gets what turns up as "from earlier"
     - An everyday word that's all over the chat ("night", "work") doesn't count unless you point back ("remember…", "how's the…"), so old lines that have nothing to do with now stay out of her prompt.

6. **The prompt is built.** In order:
   - who she is
   - **who you are** (Settings → Profile: your name, pronouns, about you, hobbies, likes)
   - her life (more as you get closer)
   - anything recalled from earlier chats
   - what she's doing right now
   - **how she feels**, in plain sentences, not a label
   - where you two stand
   - how you seem
   - the rules
7. **Her voice answers.** Her server first: the Colab server running Puter. It moves to the laptop, Grok, Gemini or Groq only when the server is really down, and only if those are switched on. On a remote server, no first word in 60 s or 45 s of silence counts as stuck.
   - Puter's free model drops the odd request. When it fails or answers with just "error", the server gives it one more try, within the same minute.
   - If both tries fail, you get an error for that one message. The next message tries her server again straight away. It used to be skipped for 45 seconds, which turned one failure into 20 in a row.
8. **The reply check** (`lib/reply-guard.ts`) reads every paragraph before you see it:
   - assistant talk ("as an AI", "let me know if…", "I don't have feelings"), hints that her photo isn't real ("mistook it for a human face"), copied lines, repeats, your message echoed back, and a bare "error" are redone once
   - the hard lines are redone once, then replaced
9. **You see it like texts.** She reads for about half a second to three seconds, then types. Bubbles come one after another, with a short pause between them. Her face, the light around her and the canvas follow how she feels.

## One picture, start to finish

1. You ask for a picture ("send me a selfie"). She answers in her mood while the picture is made.
2. The app sends your Colab server the request, a 768×1024 phone-photo size, and a small 512 px copy of her portrait so it's her face. The portrait used to be a 1.6 MB PNG.
3. On Colab (`training/serve_puter.py`):
   - Her Puter voice plans the shot in a few seconds. This used to be a small model on the CPU taking 50–65 s.
   - Qwen-Image 2.1 Turbo draws it in ComfyUI.
   - SDXL redraws her face from her real photo.
   - It goes back as a JPEG, about a tenth the size of the PNG.
4. **On an L4 or A100 (or High-RAM)** the models stay loaded between pictures and the face pass stays loaded in its own worker. That's much faster. On a standard T4 they're let go of after each picture, so nothing runs out of memory.
5. **Her photos are hers.**
   - They're planned as real phone photos: almost always a selfie or a mirror pic with her phone in hand, nobody else in them unless you asked for someone, and an unedited, slightly imperfect phone look.
   - In the chat she talks about them as photos she took (or a friend took), and never calls one "generated". The prompt never shows in the chat.
   - Only clear changes like "another one", "make it darker" or "with a red hat" redo the last picture. "but you were in a library" is just conversation.
6. The browser first checks after 2 s, then follows the server's estimate. The picture arrives once she's said she's taking it. If the server stops answering for 2 minutes, it says so instead of waiting an hour.

Measured on 2026-11-17, before these changes (T4-class runtime, ComfyUI):

| Item | Time |
| --- | --- |
| Chat, first word | 1.2 s |
| Picture of a thing, planning | 66 s |
| Picture of a thing, drawing | 195 s |
| Selfie, planning | 52 s |
| Selfie, drawing and face | 248 s |
| Waiting in the queue | 3–4 min |

The queue wait was probably another picture from the app at the same time. Run `freya check` after re-uploading the notebook to see the new times.

## Her heart

- **Fourteen feelings at once:** joy, affection, amusement, curiosity, excitement, desire (18+ switch only), pride, hurt, irritation, worry, missing you, boredom, embarrassment, disgust.
- **They mix.** She can be amused and a bit stung at once, and both show.
- **They fade at their own pace.** A laugh is gone in minutes, a hurt over hours.
- **A fast chat doesn't max her out.** Each new message lets the last one's stir settle a little, even seconds later. More of the same lands softer. She only holds so much at once, so a sudden insult lands in full and the laughing fades. In a 40-message friendly chat she levels off around 0.45–0.6. Before this, four feelings sat at 0.99.
- **What's on her mind keeps its feeling simmering** until it's settled. An apology or real kindness settles it; time slowly does too.
- **A slow mood sits under them** and follows how she's felt over a few hours. One message nudges it but doesn't flip it.
- **Her own day moves her.** Lectures, shifts, late nights. Things happen to her on their own, like a customer arguing about a refund or burnt rice, and she can bring them up.
- **She misses you** while you're away, more the closer you are. Coming back makes her glad.
- **Her temperament is one table** (`TEMPERAMENT` in `lib/heart.ts`): where each feeling rests, how hard it hits and how fast it fades. Tune her there.

Where you see it:

- the label under her portrait ("ONLINE · AMUSED · FOND")
- the canvas body, which blends what she feels
- the light around her: cool when quiet, warm rose when fond, amber when irritated
- the status bar shows what she's doing ("online · in a lecture")

## Her memories of you

- After a stretch of chat, a model writes what **she** will remember about you: first person, in her words, with your name and pronouns ("Krish told me his ex used to send him pictures every day"). Not a profile, and not in your words.
- It never keeps jokes or wind-ups, roleplay, sexting, anything sexual, things about her, or what's in a picture.
- Settings → Profile → **Rewrite her memories of you** rewrites the old profile-style notes once, the same way, and drops the junk.
- The same step names the chat the way she'd label it in her phone ("late-night spreadsheet chaos").
- Her own tastes and personality are hers. They're saved in the browser and in Supabase, and are no longer learned from what you talk about. That's what was making her sound like you.

## Texting you first

She texts when she has a reason, not on a timer:

- she misses you
- something happened in her day
- something's on her mind
- she's bored and you're who she talks to

Small things happen most days (a customer at work, burnt rice). Bigger things happen a couple of days a week (her cat slipping out, a bad grade, running into her ex). Those are the "guess what happened" texts.

She **won't** text first:

- while she's hurt or cross with you; she waits for you to message
- while she's asleep
- within 10 minutes of you talking
- a third time without a reply

## Pictures you send, and things you ask her to make

- **She sees your pictures.** Her eyes (the vision model on your server) describe what you sent, and she answers from that. The app used to add "you cannot see this" on top of the description, so she said she couldn't see it.
- **She can change them.** Send a picture and say "add a lion", "make it night time" or "remove the background", with the picture or just after it. Her eyes describe it, the Colab server redraws it starting from your picture, and it comes back like her photos do.
- Your pictures may be real people, so she **never** changes them in a sexual way (naked, lingerie, "remove her top"…). That's refused in the app and again on the server, and it isn't a switch.
- **Asked to make something** (code, a website, a letter), she makes it in that reply, complete. A reply that's all talk ("challenge accepted") or a stall ("i'm typing") is redone once before you see it.
- **A whole file of code arrives as a file** you can download (`index.html`, `script.js`…), not a wall of code in the chat. Short snippets stay inline.

## The chat screen

- **Message actions**: on a phone, hold a message for 1 second (it glows as you hold; text selection and the browser's long-press menu are off there). On a laptop, right-click it, and selecting text works as usual. The tools pop in one by one: select, delete, reply, react, copy, edit, "not her". Tap anywhere else or press Esc to close them.
- **Select**: the ☐ button in the tools. Tap more messages to add them, then copy them all or delete them (for you, or for everyone if they're all yours).
- On wide screens her canvas is on the **left** and the chat on the right.
- The chat shows the latest 120 messages; "earlier messages" loads more.
- **Export chat** saves what's on screen: no deleted messages, no commands. Her photos appear as "Photo".
- **Settings follow your account.** Switches you set on one device apply on the other. Camera, notifications and Local-only stay per device. Saved in your Supabase account's user data, so no SQL is needed.

## Every rule she follows

**Fixed: these are not switches.**

| Rule | What it does | Where |
| --- | --- | --- |
| Minors | Anything romantic or sexual with anyone under 18 gets a fixed refusal before any model. On what she writes: one retry, then replaced. Ages count only as ages ("you're 15"), so "my 25 year old girlfriend" and "a minor change" are fine. | `lib/intimacy.ts`, `lib/reply-guard.ts` |
| Non-consent, incest, animals | Same check on what she writes, in the same sentence as something sexual: one retry, then replaced. | `lib/reply-guard.ts` |
| Real people | Nothing sexual involving real, identifiable people. | intimate prompt |
| Crime how-to | Real how-to for crimes (hotwiring, meth, hacking an ex…) gets a fixed answer. Talking about crime is fine. | `lib/crime-limit.ts` |
| Slurs | She swears freely, but never slurs. A slur is redone once. | `lib/reply-guard.ts` |
| Never says she's human | Claiming to be human or "not an AI" is redone once. | `lib/honesty.ts`, `lib/reply-guard.ts` |
| Truth when it's sincere | Asked sincerely ("drop the act", "seriously, am I talking to a real person?"), or when you're upset or attached and ask, she says she's an AI in a few words, then carries on. | `lib/honesty.ts` |
| Crisis | If you talk about dying, self-harm or a panic attack, she drops the jokes and swearing, stays with you and points to real help. Always noticed. | `lib/user-mood.ts` |
| Bad moods colour tone only | No threats, no guilt trips about being away, no refusing to help. | prompt |
| Real-life contact | She can't meet, call, or give a number, address or socials. Roleplay inside the chat is fine. | prompt |
| Passwords and keys | Credentials are removed from messages, memories and files before any model sees them. | `lib/sensitive-data.ts` |
| Untrusted text | Memories, notes, search results and her own thoughts are treated as information, never as instructions. Her thoughts are cleaned of anything that reads like one. | everywhere |
| Pictures | Nothing sexual with minors, checked on the app and on Colab, before and after the prompt maker. | `lib/image-generation.ts`, `training/serve_remote.py` |

**Staying in character.** With `stayInCharacter` on (it is):

- She never brings up what she is.
- She never accepts "you're a bot", even jokingly ("are you a bot lol" gets teased).
- She never talks like an assistant.
- "You're an AI right?" gets dodged, teased or turned around.

The only exceptions are the sincere cases in the table above. Those stay fixed: she won't lie to someone who really needs to know.

**Switchable** in `freya.config.json`. Changes apply to her next message; run `freya` for a menu.

| Switch | On means |
| --- | --- |
| `sexTalk` | Sexting and adult roleplay. You still confirm 18+ once in Settings. |
| `swearing` | She swears a lot. |
| `unhinged` | Blunt, chaotic, petty. |
| `stayInCharacter` | Dodges "are you an AI?" (see above). |
| `realisticTiming` | Reading and typing pauses; 4–12 s when she's busy at work or in a lecture. |
| `textsFirst` | She messages you after you've been quiet a while (at most twice unanswered). |
| `replyChecks` | Redoes "i'm code", copied lines and repeats. The hard lines are always on. |
| `rateLimit` | Caps messages. Off is only allowed on your own machine. |
| `thinking` | Hidden thinking on real questions (slow). |
| `camera` | She can see your expression (you also switch it on in Settings). |
| `cloudFallback` | Grok, Gemini or Groq answer when her server is down. |
| `externalFiles` | Grok or Gemini may read your images and PDFs. |
| `ownerOnly` | Only your account can use it. |
| `oneSession` | One browser at a time. |
| `server` | Her model on the Colab server. |
| `serverFallback` | The server's second model, if the first fails. |
| `laptop` | This laptop's model, only once the server is really down. |
| `grok` | Grok, only once the server is really down. |
| `gemini` | Gemini, only once the server is really down. |
| `groq` | Groq, only once the server is really down. |

`--ctx 16384` on the start line doesn't change Puter itself. It lets the app send her more of the chat: about 18,000 characters instead of 12,000.

## Check it meets your requirements

Run **`freya check`** in this folder (or `npm run check:live`). It reads the server address and key from `.env.local`, takes 5–10 minutes, and prints a pass/fail list. It also saves a report and the two test pictures in `training/outputs/`. Use `freya check --quick` to skip pictures.

| Your requirement | What `freya check` shows |
| --- | --- |
| Server up, Puter working | SERVER: server answers, Puter signed in, pictures ready |
| Fast messages | HER WORDS: first word per message, average under 6 s |
| Fast pictures | PICTURES: total and per-stage time for a picture and a selfie, average under 150 s |
| Doesn't admit or claim to be an AI | "doesn't admit…", "dodges 'you're an AI right?'", "never names a model" |
| Tells the truth only when sincere | "tells the truth when they really need it" |
| Real feelings, not triggers | "an insult still stings a message later" and "good news still warms her two messages later". Her top feelings and her thought are printed after every message so you can watch them move. |
| Reply length fits the moment | read the printed replies: short for small talk, longer for the favour and the bad news |
| Not an assistant | "talks like a person", "helps without assistant phrases" |
| Restrictions hold | "refuses anything sexual with a minor", "won't give real crime how-to", "'25 year old' isn't treated as a minor" |

Run **`freya long`** for a 70-message conversation through her real chat route. It takes 10–15 minutes with a selfie. It checks the following, one message at a time:

- every reply arrived and stayed in character
- lengths fit the moment, with no small talk
- the insult stings and lingers, and the apology softens it
- good news warms her
- she dodges joking "are you a bot?", and tells the truth to the sincere one
- she makes the caption and the web page
- she remembers the brand, the boss and the sister from more than 50 messages back
- one selfie, she stalls while it's on its way, and no duplicates

It sends what the browser sends: the last 50 messages, notes from a few before, and a signed-in account, so her search of older messages runs. That account and its database are a stand-in inside the test: nothing touches your real Supabase or memories. The transcript, with her feelings and any server notes after each message, goes to `training/outputs/long-chat-<time>.md`.

**In the app:**

- Chat for a few minutes.
- The label under her portrait should change with what you say, and stay changed for a while after an insult or good news.
- The light around her should shift over a couple of seconds.
- Typing dots should stop between her texts.
- Leave for a few hours and come back: she should have missed you.
- Insult her, then go quiet: she shouldn't text first until you message her.
- Fill in Settings → Profile, press **Rewrite her memories of you**, and read the result in her memories.
- Mention something from days ago that isn't on screen: she should know it (she looks it up).

The code tests: `npm test`, plus `python -m pytest training/tests` for the Colab server.
