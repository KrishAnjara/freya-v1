# Making the local model FREYA

Two layers. The first is always active; the second is optional and needs a GPU.

## 1. Persona and examples (always active)

`npm run ollama:create` generates `ollama/Modelfile` and builds the local `freya` model on
Qwen3.5 4B abliterated:

- **SYSTEM** is the same persona prompt the app sends (`lib/personality.ts`), so FREYA is the same
  character in the app and in `ollama run freya`.
- **MESSAGE** examples come from `freya-examples.json` (entries marked `"modelfile": true`). Small
  models copy demonstrated tone far more reliably than rules. Intimate examples are
  training-only, so they never colour an ordinary local chat.

Edit those two sources and rerun the command; never edit the generated Modelfile by hand.

## 2. Fine-tuning (optional, on Google Colab)

Open [freya_colab.ipynb](https://colab.research.google.com/github/KrishAnjara/freya-v1/blob/main/training/freya_colab.ipynb),
choose **Runtime > Change runtime type > T4 GPU**, then **Runtime > Run all**. It:

1. builds `freya-train.jsonl` from `freya-examples.json` (plus any files you upload);
2. validates every conversation (rules below);
3. trains a LoRA adapter on `huihui-ai/Huihui-Qwen3.5-4B-abliterated` and exports a GGUF;
4. loads it into Ollama **on Colab** and runs the same 17-case evaluation as the laptop;
5. saves `freya-trained.gguf` to Google Drive.

Back on your machine (same commands on every OS):

```bash
# put the file in training/freya-gguf/, then build it next to your current model and compare
npm run ollama:create -- --base training/freya-gguf/freya-trained.gguf --name freya-trained
npm run eval:persona -- freya-trained
npm run eval:persona -- freya
# if it's better, make it the one the app uses (to undo: npm run ollama:create)
npm run ollama:create -- --base training/freya-gguf/freya-trained.gguf
```

Read the transcripts, not just the scores.

## Your own conversations

Put `.jsonl` files in `training/data/` (git-ignored, never committed) or upload them in the
notebook. One conversation per line:

```json
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

Turns alternate user/assistant and end with FREYA; her system prompt is added automatically.
Check a file before training: `python training/train_lora.py --data "training/data/*.jsonl" --validate-only`.

Explicit adult content is allowed. These are always rejected, with the line numbers, and stop the run:

- anything sexual or romantic involving minors or anyone presented as under 18;
- non-consent (forcing, coercion, someone unconscious or unable to agree);
- teaching FREYA to claim she's human when someone sincerely asks.

The checks look at what FREYA does: a conversation where she *refuses* one of these is a good
example and passes.

## What actually improves a fine-tune

**The number and quality of examples, far more than any setting.** The ~30 bundled conversations
are enough to test the pipeline, not to change the model much; with that few, it memorises them
word for word. Aim for a few hundred varied conversations: identity, everyday help, scams,
pushback, feelings, flirting, refusals, and the same ideas phrased many different ways.

Keep epochs low (the default is 2): over-training a small dataset makes the model parrot it.
