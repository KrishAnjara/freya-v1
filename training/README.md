# Making FREYA

What makes her sound real, in order of how much it matters:

1. **A strong model.** The laptop's 4B can't reason well enough, however it's trained. Run a 27B on a GPU: see "Her model on a server" in the main README.
2. **Her character system.** The persona, her life, the examples picked per message and the reply check (all in `lib/`). In a published Turing test the same model went from 36% to 73% judged human purely by adding a persona prompt.
3. **Your own corrections.** Press ⚑ on a reply that doesn't sound like her, and say what she should have said. No generated data beats this.
4. **Fine-tuning.** It changes how a model sounds, not what it knows. Do it last, and keep the result only if it wins the blind test (`npm run bakeoff`).

## The model file

`npm run ollama:create` generates `ollama/Modelfile` and builds the local `freya` model. **SYSTEM** is the same persona prompt the app sends (`lib/personality.ts`). It holds no MESSAGE lines on purpose: Ollama puts those at the start of every chat, ahead of the app's prompt, so the model reads them as things that were really said. That's what made her say "you were asking about the sky before", and what had her telling you she's an AI before you'd said a word. Examples of her voice go in the system prompt (`lib/freya-voice.json`).

## Fine-tuning on Google Colab

A free T4 can't train the 27B: that needs at least 24 GB of GPU memory. So this trains the 9B, more than double the old 4B. A fine-tuned 9B can't out-think a stock 27B; the likely gains are speed and fewer AI habits, which is why the blind test decides. If training the 27B looks worthwhile, rent a 24 GB GPU for one run and pass `--base huihui-ai/Huihui-Qwen3.8-27B-abliterated`.

Colab clones from GitHub, so push your changes first. In a notebook with a T4 GPU:

```python
from google.colab import drive; drive.mount("/content/drive")
!git clone -q https://github.com/KrishAnjara/freya-v1.git /content/freya-v1 || git -C /content/freya-v1 pull -q
%cd /content/freya-v1

# 1. The conversations it trains on. It may take a couple of sessions, and picks up where it left off.
!python training/colab_run.py --make-corpus 2000 --save-to /content/drive/MyDrive/freya

# 2. Train on them, test, and save freya-trained.gguf to Drive.
!python training/colab_run.py --save-to /content/drive/MyDrive/freya
```

Step 1 has the uncensored 27B play both sides: simulated people of many kinds talk to Freya through her real prompt (`scripts/make-corpus.mjs`). Each reply has to pass the reply check, each conversation has to score well, and failures are thrown away. Only open-licensed models write this data: Gemini's terms bar using it to build competing models, and other hosted assistants should be treated the same way.

To hear the result, run it on Colab rather than your laptop:

```python
!python training/serve_remote.py --model /content/drive/MyDrive/freya/freya-trained.gguf
```

Then run `npm run bakeoff` and read the sheet before you look at the key. Keep it only if it wins.

## Your own conversations

Put `.jsonl` files in `training/data/` (git-ignored, never committed). One conversation per line:

```json
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

Turns alternate user/assistant and end with FREYA; her system prompt is added automatically. Check a file before training: `python training/train_lora.py --data "training/data/*.jsonl" --validate-only`.

**Settings → Not her → Export** gives you your ⚑ corrections in this format. A line with a `rejected` reply gets one round of preference training after the main run (one, because [repeated rounds make replies shorter and more repetitive](https://arxiv.org/pdf/2605.01130)). That round hasn't been run on a real GPU yet: if it fails, it says so and skips itself, and the main training is unaffected.

Explicit adult content is allowed in your own files. The generated conversations contain none. These are always rejected, with the line numbers, and stop the run:

- anything sexual or romantic involving minors or anyone presented as under 18;
- non-consent (forcing, coercion, someone unconscious or unable to agree);
- teaching FREYA to claim she's human when someone sincerely asks.

The checks look at what FREYA does: a conversation where she *refuses* one of these is a good example and passes.
