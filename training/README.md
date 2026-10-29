# Making the local model FREYA

Two layers. The first is always active. The second is optional and needs a GPU.

## 1. Persona and examples (active now)

`npm run ollama:create` generates `ollama/Modelfile` and rebuilds the local `freya` model:

- **SYSTEM** is the same compact persona the app sends (`lib/personality.ts`, including
  `AGENT_IDENTITY`), so FREYA is the same character in the app and in `ollama run freya`.
- **MESSAGE** examples come from `training/freya-examples.json` (entries marked
  `"modelfile": true`). A 3B model copies demonstrated tone far more reliably than rules.

To change who she is, edit those two sources and rerun the command. Don't edit the generated
Modelfile by hand.

## 2. LoRA fine-tune (optional, needs a CUDA GPU)

This bakes the persona into the weights, so it holds better on long chats and with short
prompts. It does not run on this machine (no NVIDIA GPU); a free Google Colab T4 is enough.

1. Build the dataset here: `npm run train:data`. This writes `training/freya-train.jsonl`
   from the same examples, each with the app's system prompt.
2. In Colab (GPU runtime), upload `freya-train.jsonl` and `train_lora.py`, then:
   ```
   pip install unsloth trl datasets
   python train_lora.py --data freya-train.jsonl --out freya-gguf
   ```
3. Download `freya-gguf/unsloth.Q4_K_M.gguf` into `training/freya-gguf/` and rebuild:
   ```
   FREYA_BASE_MODEL=./training/freya-gguf/unsloth.Q4_K_M.gguf npm run ollama:create
   ```

**Dataset size matters more than settings.** The 22 bundled conversations are a seed, enough to
check the pipeline but too few for a strong fine-tune. Aim for a few hundred varied ones:
identity, everyday help, scams, pushback, feelings, voice notes, and capability honesty (what
she can't do). Every reply must sound like FREYA and must never invent past missions, contacts
or real-world actions.

To undo: `FREYA_BASE_MODEL=huihui_ai/qwen2.5-abliterate:3b npm run ollama:create` (the default),
or `FREYA_BASE_MODEL=qwen2.5:3b` for the stock model.
