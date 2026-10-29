"""
LoRA fine-tune of an abliterated Qwen2.5 3B (huihui-ai ...-abliterated-SFT) into FREYA, exported as a GGUF for Ollama.

Needs a CUDA GPU (a free Google Colab T4 is enough for 3B with 4-bit loading). It will not
run usefully on a CPU-only machine.

    pip install unsloth trl datasets
    python train_lora.py --data freya-train.jsonl --out freya-gguf

Then, back in the project:

    FREYA_BASE_MODEL=./training/freya-gguf/unsloth.Q4_K_M.gguf npm run ollama:create

LoRA trains a small set of extra weights and leaves the base model's knowledge in place, so
FREYA keeps the model's abilities and only her voice, persona and habits are reinforced.
Keep the epochs and learning rate modest: over-training on a small dataset makes a model
repeat its examples word for word.
"""

# Unsloth patches trl/transformers when imported, so it must come before them.
import unsloth  # noqa: F401  (imported for its patches)
from unsloth import FastLanguageModel
from unsloth.chat_templates import train_on_responses_only

import argparse

from datasets import load_dataset
from trl import SFTConfig, SFTTrainer

parser = argparse.ArgumentParser()
parser.add_argument("--data", default="freya-train.jsonl")
parser.add_argument("--out", default="freya-gguf")
# The laptop's Ollama base (huihui_ai/qwen2.5-abliterate:3b) came from huihui-ai's
# Qwen2.5-3B-Instruct-abliterated, which has since been removed from Hugging Face; only GGUF
# copies remain, and those can't be trained. This is the same author's model built on those
# exact weights, with full safetensors. Alternative: Bender1011001/Qwen2.5-3B-Instruct-ABLITERATED.
parser.add_argument("--base", default="huihui-ai/Qwen2.5-3B-Instruct-abliterated-SFT")
parser.add_argument("--epochs", type=float, default=3)
parser.add_argument("--rank", type=int, default=16)
args = parser.parse_args()

model, tokenizer = FastLanguageModel.from_pretrained(model_name=args.base, max_seq_length=4096, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(
    model,
    r=args.rank,
    lora_alpha=args.rank * 2,
    lora_dropout=0.0,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
)

# Each line: {"messages": [system, user, assistant, ...]}, rendered with Qwen's own template.
dataset = load_dataset("json", data_files=args.data, split="train")
dataset = dataset.map(lambda row: {"text": tokenizer.apply_chat_template(row["messages"], tokenize=False)})

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=SFTConfig(
        dataset_text_field="text",
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=args.epochs,
        learning_rate=1e-4,
        warmup_ratio=0.05,
        logging_steps=5,
        output_dir="checkpoints",
        report_to="none",
    ),
)
# Learn only from FREYA's replies, not from the system prompt or the user's turns.
trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")
trainer.train()

# Merge the adapter into the base and export one quantised GGUF that Ollama can load directly.
model.save_pretrained_gguf(args.out, tokenizer, quantization_method="q4_k_m")
print(f"Done. GGUF written to {args.out}/")
