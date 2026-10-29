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
choose **Runtime > Change runtime type > T4 GPU**, then run its one cell. Or, in any Colab
notebook, one cell:

```python
from google.colab import drive; drive.mount("/content/drive")
!git clone -q https://github.com/KrishAnjara/freya-v1.git /content/freya-v1 || git -C /content/freya-v1 pull -q
%cd /content/freya-v1
!python training/colab_run.py --save-to /content/drive/MyDrive/freya
```

Either way, `training/colab_run.py` does every step (`--smoke` for a quick 10-step check). It:

1. builds `freya-train.jsonl` from `freya-examples.json` (plus any files you upload);
2. validates every conversation (rules below);
3. trains a LoRA adapter on `huihui-ai/Huihui-Qwen3.5-4B-abliterated` and exports a GGUF;
4. loads it into Ollama **on Colab** and runs the same 17-case evaluation as the laptop;
5. saves `freya-trained.gguf` to Google Drive.

Back on your machine: put `freya-trained.gguf` in `training/freya-gguf/` and run `start.bat`
(Windows) or `sh start.sh`. It reads the file's model family, builds FREYA from it with the
matching chat format (no download), and starts the app. It rebuilds only when the file changes.
To go back to the stock model, delete the file and run `npm run ollama:create`.

The Colab run already evaluated the model; read those transcripts, not just the score.

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
