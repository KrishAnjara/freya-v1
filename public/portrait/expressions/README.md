# FREYA portrait expressions

Put expression images in this folder (`public/portrait/expressions/`). The app lists what is
here (`/api/portrait/expressions`) and crossfades the portrait to the matching image when
FREYA's expression changes. Any expression without an image is drawn procedurally on the
base portrait (`app/static/freya.png`), so you can add these one at a time.

## Files

| File | Expression | When it shows | Description |
|---|---|---|---|
| `neutral.png` | neutral | content, bored or tired moods | Optional: the base portrait already is neutral. Add only if you regenerate the set and want an exact match. Relaxed face, lips closed. |
| `smile.png` | smile | "lol", "smile for me", her own jokes | Soft closed-mouth smile, cheeks slightly lifted, eyes a little narrowed. |
| `smile-2.png` | smile (variation) | alternates with `smile.png` | A bigger smile, closed mouth or a hint of teeth, eyes crinkled. |
| `laugh.png` | laugh | "lmao", "😂", her own laughing | Genuine laugh: mouth open, teeth showing, eyes crinkled, cheeks high. |
| `curious.png` | curious | curious or restless moods (the default) | One eyebrow slightly raised, eyes engaged, lips closed, a faint smile. |
| `curious-2.png` | curious (variation) | alternates with `curious.png` | Both brows slightly raised, eyes wide and interested, lips closed. |
| `surprised.png` | surprised | "omg", "guess what", "!!" | Brows high, eyes wide, lips parted in a small "oh". |
| `sad.png` | sad | melancholy or sulking moods, bad news | Inner brows raised, mouth corners down, eyes slightly lowered, lips closed. |
| `affectionate.png` | affectionate | warm mood, "love you", "miss you" | Warm, soft smile, softened eyes, relaxed brows, lips closed. |
| `thinking.png` | thinking | while she works out a reply | Eyes looking up and to her right (the viewer's left), lips pressed together, slight brow knit. |
| `thinking-2.png` | playful | playful mood only, including while she thinks | Side-eye glance with a one-sided smirk. Not used for ordinary thinking. |
| `confused.png` | confused | "???", "what do you mean" | One brow furrowed, the other raised, slight frown, lips closed. |
| `confident.png` | confident | irritated mood (cool, composed) | Subtle one-sided smirk, steady direct gaze, lips closed. |

Expressions are chosen in `lib/expression.ts`. Names are fixed: `smile.png`, and numbered
variations `smile-2.png`, `smile-3.png`. PNG, JPG and WebP all work. Other names are ignored.

## Requirements (the 3D relief depends on these)

1. **Same canvas as `app/static/freya.png`:** 1408 × 768 px, landscape.
2. **Identical framing:** the same camera, head size and position, shoulders, hair, clothing,
   lighting and dark green-black background. Only the face changes. The app animates eyes and
   lips from fixed points measured on the base image (eyes ~36% down, lips ~60% down, centred),
   so a moved face makes the animation drift off the features.
3. **Head straight on, not tilted:** tilt, nods and gaze shifts are added by the app.
4. **Mouth closed** in every image except `laugh` and `surprised`, so her lips can move when she
   speaks.
5. **No watermark, text or logo inside the central square:** the centre 768 × 768 px, x 320 to
   1088, is what the relief uses.
6. **Check:** overlay each image on `freya.png` at 50% opacity. Eyes, nose and lips should line
   up within a few pixels.
