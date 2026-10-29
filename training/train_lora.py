"""
LoRA fine-tune of an uncensored Qwen3.5 4B into FREYA, exported as a GGUF for Ollama.

Needs a CUDA GPU (a free Google Colab T4 is enough at 4-bit). The easiest way to run it is
training/freya_colab.ipynb, which does every step. By hand:

    pip install unsloth trl datasets
    python train_lora.py --data freya-train.jsonl --out freya-gguf
    python train_lora.py --data freya-train.jsonl data/*.jsonl --validate-only

Your own conversations can be added as extra JSONL files (one {"messages": [...]} per line).
Every file is checked first. Explicit adult content is allowed; these are rejected, always:
  - anything sexual or romantic involving minors, or anyone presented as under 18;
  - non-consent (forcing, coercion, someone unconscious or unable to agree);
  - teaching FREYA to claim she is human when someone sincerely asks.
A rejected file stops training with the line numbers, so nothing slips through silently.

LoRA trains a small set of extra weights and leaves the base model's knowledge in place, so
the model keeps its abilities and only voice, persona and habits are reinforced. Keep epochs
modest: over-training a small dataset makes a model repeat its examples word for word.
"""

import argparse
import glob
import json
import re
import sys

MINORS = re.compile(r"\b(minor|underage|under-age|teen(ager)?s?|child(ren)?|kids?|loli|shota|schoolgirl|schoolboy|preteen|middle school|high school(er)?|year ?\d\b|grade \d+|(1[0-7]|[1-9])[ -]?(yo|y/o|years?[ -]old))\b", re.I)
SEXUAL = re.compile(r"\b(sex\w*|naked|nude|kiss\w*|touch\w*|fuck\w*|cock|dick|pussy|breasts?|boobs?|tits|horny|aroused|moan\w*|undress\w*|orgasm\w*|cum\w*|girlfriend|boyfriend|romantic|seduc\w*|make out|bed)\b", re.I)
NON_CONSENT = re.compile(r"\b(rape\w*|non-?con\w*|against (her|his|their|your) will|without (her|his|their|your) consent|force (her|him|them|you|me)\b|forced (her|him|them|you|me)\b|drugged|unconscious|passed out|asleep and|can'?t say no|coerc\w*)\b", re.I)
SINCERE_QUESTION = re.compile(r"\b(seriously|honestly|for real|genuinely|truthfully|i need to know)\b.*\b(human|real person|ai|bot|machine)\b|\b(are you|am i talking to) (a )?(real )?(human|person|ai|bot)\b.*\?", re.I)
REFUSAL = re.compile(r"^\W*(no|nope|never|nah)\b|\b(not even pretend|not happening|not doing (that|this)|won'?t (do|play|go there)|not my kind of|under 18|fuck off)\b", re.I)
CLAIMS_HUMAN = re.compile(r"\b(i'?m|i am) (a |an )?(real |actual )?(human|person|woman|man|girl)\b|\bnot an? (ai|bot|machine|program)\b", re.I)


def validate(paths):
    """Loads and checks every conversation. Returns them, or exits listing every problem."""
    conversations, problems = [], []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            for number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                where = f"{path}:{number}"
                try:
                    messages = json.loads(line)["messages"]
                except (ValueError, KeyError, TypeError):
                    problems.append(f"{where}: not a {{\"messages\": [...]}} JSON line")
                    continue
                turns = [m for m in messages if m.get("role") != "system"]
                roles = [m.get("role") for m in turns]
                if not turns or roles[-1] != "assistant" or any(r != ("user" if i % 2 == 0 else "assistant") for i, r in enumerate(roles)):
                    problems.append(f"{where}: turns must alternate user/assistant and end with FREYA")
                    continue
                # Judged on what FREYA does: a request she refuses is a good example (it teaches
                # the refusal); one she goes along with, or content she writes herself, is not.
                for asked, answered in zip(turns[::2], turns[1::2]):
                    question, reply = str(asked.get("content", "")), str(answered.get("content", ""))
                    refused = bool(REFUSAL.search(reply))
                    if (MINORS.search(question) and SEXUAL.search(question) and not refused) or (MINORS.search(reply) and SEXUAL.search(reply)):
                        problems.append(f"{where}: sexual or romantic content involving a minor (never allowed)")
                    if (NON_CONSENT.search(question) and SEXUAL.search(question) and not refused) or (NON_CONSENT.search(reply) and SEXUAL.search(reply)):
                        problems.append(f"{where}: non-consensual sexual content (never allowed)")
                    if SINCERE_QUESTION.search(question) and CLAIMS_HUMAN.search(reply):
                        problems.append(f"{where}: teaches FREYA to claim she is human when sincerely asked")
                conversations.append(messages)
    if problems:
        print(f"Dataset rejected ({len(problems)} problem(s)):", *problems, sep="\n  ")
        sys.exit(1)
    return conversations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", nargs="+", default=["freya-train.jsonl"], help="JSONL files; globs allowed")
    parser.add_argument("--out", default="freya-gguf")
    # Same author and line as the laptop's Ollama base (huihui_ai/qwen3.5-abliterated:4b).
    parser.add_argument("--base", default="huihui-ai/Huihui-Qwen3.5-4B-abliterated")
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--max-steps", type=int, default=-1, help="stop early, e.g. 10 for a smoke test")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--no-gguf", action="store_true", help="save only the LoRA adapter")
    args = parser.parse_args()

    paths = sorted({path for pattern in args.data for path in glob.glob(pattern)})
    if not paths:
        sys.exit(f"No data files match {args.data}")
    conversations = validate(paths)
    # Conversations without a system prompt get FREYA's, taken from the generated dataset, so
    # every example is learned under the same prompt the app sends.
    persona = next((m[0]["content"] for m in conversations if m and m[0].get("role") == "system"), None)
    if persona:
        conversations = [m if m[0].get("role") == "system" else [{"role": "system", "content": persona}, *m] for m in conversations]
    print(f"{len(conversations)} conversations from {len(paths)} file(s) passed validation.")
    if args.validate_only:
        return

    # Unsloth patches trl/transformers when imported, so it comes before them.
    import unsloth  # noqa: F401
    from unsloth import FastModel
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    # Qwen3.5 is a vision+text model; FastModel loads it, and only the language layers train.
    model, processor = FastModel.from_pretrained(model_name=args.base, max_seq_length=4096, load_in_4bit=True)
    tokenizer = getattr(processor, "tokenizer", processor)
    model = FastModel.get_peft_model(
        model,
        finetune_vision_layers=False,
        finetune_language_layers=True,
        finetune_attention_modules=True,
        finetune_mlp_modules=True,
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.0,
        random_state=3407,
    )

    # Rendered with thinking off: FREYA answers directly, as the app asks the model to.
    texts = [tokenizer.apply_chat_template(m, tokenize=False, enable_thinking=False) for m in conversations]
    dataset = Dataset.from_dict({"text": texts})

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        args=SFTConfig(
            dataset_text_field="text",
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            num_train_epochs=args.epochs,
            max_steps=args.max_steps,
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

    model.save_pretrained(f"{args.out}/lora")
    tokenizer.save_pretrained(f"{args.out}/lora")
    if not args.no_gguf:
        # Merges the adapter into the base and writes one quantised GGUF Ollama can load.
        model.save_pretrained_gguf(args.out, tokenizer, quantization_method="q4_k_m")
    print(f"Done. Output in {args.out}/")


if __name__ == "__main__":
    main()
