# Image prompts for FREYA's expressions

Each image is an **edit of `app/static/freya.png`**: the same woman, photo, framing and light, with only
her face changed. That's what makes the portrait work: the app crossfades between these images and moves
her eyes, brows and lips on top, so every image has to line up with the base portrait almost exactly.

## The rules every image must follow

- **Size:** 1408 × 768 px, saved as **real PNG** (not a JPEG renamed `.png`).
- **Same everything except the face:** person, head size and position, camera angle, hair, shoulders,
  clothing, lighting, colour grade, dark background.
- **Head straight and level**, facing the camera, unless the prompt says the eyes move.
- **Lips closed** unless the prompt says otherwise, so the app can open them when she talks.
- **Check alignment:** overlay the result on `freya.png` at 50% opacity. Eyes, nose and lips should line
  up within a few pixels. If they don't, generate again with a new seed.
- **Expressions are natural and small.** She's a sharp, dry 20-year-old, not a cartoon: a smile is a
  smile, not a grin to the ears.

### Fix these first

These files are currently small JPEGs (1024 × 559, ~35 KB) with a `.png` name, so they look soft next to
the others: `look-left`, `look-left-2`, `look-right`, `look-right-2`, `reading`, `reading-3`, `reading-4`,
`sultry`, `sultry-2`, `sultry-3`, `sultry-5`, `sultry-thinking`, `sultry-thinking-3`. Replace them with the
prompts below. Also missing: `look-up`, `look-up-2`, `look-down`, `look-down-2`.

## Prefix: put this before every prompt

> Edit this photo. Keep the exact same woman (adult, 20 years old), the same face shape, eyes, nose, lips,
> skin, hair, clothing, shoulders, camera, framing, head size and position, lighting, colour grade and
> dark background. Head straight and level, facing the camera. Photorealistic, natural skin texture,
> same sharpness as the original. Change only her facial expression:

## Negative prompt (if the tool has one)

> different person, changed face shape, changed hair, changed clothes, head turned, tilted head, moved
> head, cropped, zoomed, extra fingers, hands, teeth when mouth should be closed, exaggerated cartoon
> expression, plastic skin, blur, text, watermark

## The prompts

Variations (`-2`, `-3`) are different takes on the same feeling, so she doesn't repeat one face.

### Resting

| File | Expression |
|---|---|
| `neutral.png` | Relaxed, neutral face, mouth closed and soft, eyes calm and looking at the camera. Nothing happening on her face. |
| `neutral-2.png` | Neutral face with the faintest hint of amusement in the eyes only, mouth closed and relaxed. |

### Happy

| File | Expression |
|---|---|
| `smile.png` | A soft closed-mouth smile, cheeks slightly lifted, eyes a little narrowed and warm. |
| `smile-2.png` | A bigger smile showing a little of the upper teeth, eyes crinkled at the corners. |
| `smile-3.png` | A small lopsided smile, one corner of the mouth higher, amused eyes. |
| `smile-4.png` | A shy, pressed-lips smile, eyes glancing down slightly then back at the camera. |
| `laugh.png` | A genuine laugh: mouth open showing teeth, eyes crinkled almost shut, cheeks high. |
| `laugh-2.png` | Mid-laugh, head still level, mouth open, eyes squeezed, lines at the eyes. |
| `laugh-3.png` | Trying not to laugh: lips pressed together and curling up, cheeks puffed slightly, eyes watering with amusement. |
| `excited.png` | Excited: eyebrows raised, eyes wide and bright, open smile showing teeth. |
| `excited-2.png` | Delighted surprise: brows up, mouth open in a happy "oh!", bright eyes. |

### Warm

| File | Expression |
|---|---|
| `affectionate.png` | Warm, soft smile, softened eyes, relaxed brows, mouth closed. Looks at the camera fondly. |
| `affectionate-2.png` | Tender look: small closed smile, eyes slightly glossy and soft, brows relaxed and a little raised. |
| `affectionate-3.png` | Fond, slightly embarrassed smile, eyes looking down then up at the camera. |

### Playful and confident

| File | Expression |
|---|---|
| `playful.png` | Teasing smirk, one corner of the mouth up, one eyebrow slightly raised, mischievous eyes. |
| `playful-2.png` | Side-eye glance toward the left of the picture with a knowing one-sided smile. |
| `playful-3.png` | Tongue-in-cheek grin: lips closed, cheek pushed out on one side, eyes amused. |
| `confident.png` | Cool, composed half-smile, steady direct gaze, chin level, mouth closed. |
| `confident-2.png` | Unimpressed confidence: eyebrows level, slight smirk, eyes narrowed a touch. |
| `confident-3.png` | Calm self-assured look, faint smile, relaxed eyelids, direct gaze. |
| `sultry.png` | Slow, confident look: eyelids slightly lowered, soft half-smile, lips closed and relaxed. Tasteful, fully clothed, same framing. |
| `sultry-2.png` | Teasing look from under slightly lowered lashes, one corner of the mouth up, lips closed. |
| `sultry-3.png` | Lips slightly parted, relaxed heavy-lidded eyes, calm and self-assured. |
| `sultry-thinking.png` | Heavy-lidded eyes glancing up to the right of the picture, small knowing smile, lips closed. |
| `sultry-thinking-3.png` | Biting the corner of her lower lip lightly, eyes looking slightly to the side, amused. |

### Curious and thinking

| File | Expression |
|---|---|
| `curious.png` | One eyebrow slightly raised, eyes engaged and focused, faint smile, mouth closed. |
| `curious-2.png` | Both eyebrows slightly raised, eyes wide and interested, mouth closed. |
| `interested.png` | Leaning-in look without moving the head: eyes focused and bright, brows slightly raised, small smile. |
| `interested-2.png` | Attentive, eyes slightly narrowed in concentration, lips closed, faint nod of the brows. |
| `thinking.png` | Eyes looking up and to the left of the picture, lips pressed together, slight brow knit. |
| `thinking-3.png` | Lips pursed to one side, eyes looking up, considering something. |
| `thinking-4.png` | Eyes looking slightly down and to the side, brows drawn together a little, mouth closed. |
| `confused.png` | One brow furrowed, the other raised, slight frown, mouth closed. |
| `confused-2.png` | Squinting slightly, head level, mouth twisted to one side in disbelief. |
| `surprised.png` | Brows high, eyes wide, lips parted in a small "oh". |
| `surprised-2.png` | Mild surprise: brows raised, eyes widened, mouth closed. |
| `surprised-3.png` | Shocked: brows high, eyes wide, mouth open, teeth slightly visible. |

### Low moods

| File | Expression |
|---|---|
| `sad.png` | Inner brows raised, mouth corners down, eyes slightly lowered and glossy, lips closed. |
| `sad-2.png` | Quiet sadness: eyes looking down, lips pressed together, brows slightly pinched. |
| `sad-3.png` | Brave sad smile: small closed smile that doesn't reach the eyes, eyes glossy. |
| `tired.png` | Tired: heavy half-closed eyelids, relaxed slack face, mouth closed. |
| `tired-2.png` | Sleepy: eyes nearly closed, slight yawn with lips parted a little. |
| `bored.png` | Bored: eyelids half lowered, flat mouth, eyes looking off to the side of the picture. |
| `bored-2.png` | Unimpressed boredom: one cheek pushed out, flat stare at the camera. |

### Sour

| File | Expression |
|---|---|
| `annoyed.png` | Annoyed: brows drawn down, eyes narrowed, lips pressed flat. |
| `annoyed-2.png` | Eye-roll: eyes rolled up, lips pressed into a flat line, brows slightly raised. |
| `disgusted.png` | Mild disgust: nose slightly wrinkled, upper lip raised a little, brows down. |
| `disgusted-2.png` | "Ew": mouth pulled to one side, nose wrinkled, eyes squinting. |

### Looking around (eyes move, head doesn't)

Left and right mean as you look at the picture.

| File | Expression |
|---|---|
| `look-left.png` | Eyes turned to the left of the picture, relaxed face, lips closed. Head does not turn. |
| `look-left-2.png` | Eyes turned to the left of the picture with a faint knowing smile, lips closed. |
| `look-right.png` | Eyes turned to the right of the picture, relaxed face, lips closed. Head does not turn. |
| `look-right-2.png` | Eyes turned to the right of the picture, one eyebrow slightly raised, lips closed. |
| `look-up.png` | Eyes looking up, as if remembering something, relaxed face, lips closed. |
| `look-up-2.png` | Eyes rolled up in mild exasperation, lips pressed flat. |
| `look-down.png` | Eyes lowered, lids partly closed, calm face, lips closed. |
| `look-down-2.png` | Eyes lowered with a small private smile, lips closed. |

### Reading your message

| File | Expression |
|---|---|
| `reading.png` | Eyes lowered as if reading a phone held below the frame, calm focused face, lips closed. |
| `reading-3.png` | Reading with a faint smile starting, eyes lowered, lips closed. |
| `reading-4.png` | Reading with brows slightly raised in interest, eyes lowered, lips closed. |

## Generating them all on Colab

Use the same model the image server uses (Qwen-Image-Edit 2511). On an **A100 High-RAM** runtime, upload
`app/static/freya.png` to the Colab file panel, then run this cell. It writes every file above to
`/content/expressions/` as PNG, plus a zip to download. Copy the files into `public/portrait/expressions/`.

```python
!pip -q install -U diffusers transformers accelerate peft safetensors
import re, torch, zipfile, os
from diffusers import DiffusionPipeline
from diffusers.utils import load_image

PREFIX = ("Edit this photo. Keep the exact same woman (adult, 20 years old), the same face shape, eyes, nose, lips, "
          "skin, hair, clothing, shoulders, camera, framing, head size and position, lighting, colour grade and dark "
          "background. Head straight and level, facing the camera. Photorealistic, natural skin texture, same sharpness "
          "as the original. Change only her facial expression: ")
NEGATIVE = ("different person, changed face shape, changed hair, changed clothes, head turned, tilted head, moved head, "
            "cropped, zoomed, hands, exaggerated cartoon expression, plastic skin, blur, text, watermark")
# The tables above, read from this file if you upload PROMPTS.md too; otherwise paste rows here.
rows = re.findall(r"^\| `([a-z-]+(?:-\d)?\.png)` \| (.+?) \|$", open("PROMPTS.md").read(), re.M)

pipe = DiffusionPipeline.from_pretrained("Qwen/Qwen-Image-Edit-2511", torch_dtype=torch.bfloat16).to("cuda")
base = load_image("freya.png").convert("RGB")
os.makedirs("/content/expressions", exist_ok=True)
for name, expression in rows:
    image = pipe(image=[base], prompt=PREFIX + expression, negative_prompt=NEGATIVE, true_cfg_scale=4.0,
                 guidance_scale=1.0, num_inference_steps=40, generator=torch.Generator("cpu").manual_seed(7),
                 width=1408, height=768).images[0]
    image.resize((1408, 768)).save(f"/content/expressions/{name}", "PNG")
    print("saved", name)
with zipfile.ZipFile("/content/expressions.zip", "w") as archive:
    for name in os.listdir("/content/expressions"):
        archive.write(f"/content/expressions/{name}", name)
```

Upload `PROMPTS.md` to the Colab file panel as well, so the cell reads the prompts from it. Then check a
few against `freya.png` at 50% opacity before replacing the old ones; a seed that drifts can be redone on
its own by changing `manual_seed`.
