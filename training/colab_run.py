"""
FREYA on Google Colab in one go: train, test, and save the fine-tuned model.

In a Colab notebook with a GPU (Runtime > Change runtime type > T4 GPU), run ONE cell:

    from google.colab import drive; drive.mount("/content/drive")
    !git clone -q https://github.com/KrishAnjara/freya-v1.git /content/freya-v1 || git -C /content/freya-v1 pull -q
    %cd /content/freya-v1
    !python training/colab_run.py --save-to /content/drive/MyDrive/freya

It saves MyDrive/freya/freya-trained.gguf. Run it on Colab's GPU instead of your laptop with
training/serve_remote.py --model /content/drive/MyDrive/freya/freya-trained.gguf
Then use the blind test (npm run bakeoff) to decide whether it beats the stock 27B.

First, make the conversations it trains on. This can take a couple of sessions, and picks up where it
left off:

    !python training/colab_run.py --make-corpus 2000 --save-to /content/drive/MyDrive/freya

Then train on them:

    !python training/colab_run.py --save-to /content/drive/MyDrive/freya

Options:
  --make-corpus N  make N conversations with the uncensored 27B, saved to --save-to, then stop
  --base NAME    base model (default: Qwen3.5 9B abliterated; a free T4 can't train the 27B)
  --epochs N     training epochs (default 2)
  --smoke        10 training steps and no export: just checks everything loads
  --no-eval      skip the persona evaluation
  --save-to DIR  copy the result there (mount Google Drive first, as above)

Your own conversations: put .jsonl files in training/data/ before running (see
training/README.md). Every file is validated; disallowed content stops the run.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QWEN35 = "huihui-ai/Huihui-Qwen3.5-9B-abliterated"
QWEN3_FALLBACK = "huihui-ai/Huihui-Qwen3-4B-Instruct-2507-abliterated"


def step(title):
    print(f"\n=== {title} ===", flush=True)


def run(command, **options):
    """Runs a shell command from the repo root and stops everything if it fails."""
    print(f"$ {command}", flush=True)
    result = subprocess.run(command, shell=True, cwd=ROOT, **options)
    if result.returncode != 0:
        sys.exit(f"\nStopped: `{command}` failed (exit {result.returncode}). See the output above.")


def ollama_ready():
    try:
        urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2)
        return True
    except OSError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default=QWEN35)
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--no-eval", action="store_true")
    parser.add_argument("--save-to", default="")
    parser.add_argument("--make-corpus", type=int, default=0)
    args = parser.parse_args()
    started = time.time()
    corpus = os.path.join(args.save_to, "freya-corpus.jsonl") if args.save_to else "training/data/freya-corpus.jsonl"

    step("1/6 GPU")
    if shutil.which("nvidia-smi") is None or subprocess.run("nvidia-smi -L", shell=True).returncode != 0:
        sys.exit("No GPU. In Colab: Runtime > Change runtime type > T4 GPU, then run the cell again.")

    step("2/6 Install training tools and Node.js")
    run(f"{sys.executable} -m pip install -q unsloth trl datasets")
    if shutil.which("node") is None:
        run("curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null && apt-get install -y -qq nodejs > /dev/null")
    run("node --version")

    if args.make_corpus:
        step("Make the conversations: the 27B writes them, on this GPU")
        sys.path.insert(0, os.path.join(ROOT, "training"))
        import serve_remote
        serve_remote.install_ollama()
        candidates = next(models for floor, models in serve_remote.MODELS_BY_VRAM if serve_remote.gpu_gigabytes() >= floor)
        serve_remote.load_fitting(candidates, serve_remote.CONTEXTS)
        run(f'npx -y tsx scripts/make-corpus.mjs --target {args.make_corpus} --provider ollama --out "{corpus}"')
        print(f"\nConversations are in {corpus}. Run this again without --make-corpus to train on them.")
        return

    step("3/6 Build and validate the training data")
    os.makedirs(os.path.join(ROOT, "training", "data"), exist_ok=True)
    run("npx -y tsx scripts/build-training-data.mjs")
    data = 'training/freya-train.jsonl "training/data/*.jsonl"'
    if os.path.exists(corpus if os.path.isabs(corpus) else os.path.join(ROOT, corpus)):
        data += f' "{corpus}"'
    run(f"{sys.executable} training/train_lora.py --data {data} --validate-only")

    step(f"4/6 Train on {args.base}" + (" (smoke test)" if args.smoke else ""))
    extra = "--max-steps 10 --no-gguf" if args.smoke else ""
    run(f'{sys.executable} training/train_lora.py --data {data} --base "{args.base}" --epochs {args.epochs} --out training/freya-gguf {extra}')
    if args.smoke:
        print("\nSmoke test passed: everything loads and trains. Run again without --smoke for the real model.")
        return

    # Unsloth names its export differently between versions; the model is the largest .gguf
    # that isn't the vision projector. It is renamed to the one name the laptop looks for.
    files = [path for path in glob.glob(os.path.join(ROOT, "training", "freya-gguf_gguf", "*.gguf")) if "mmproj" not in path.lower()]
    if not files:
        sys.exit("Training finished but no .gguf was exported. See the output above.")
    model = os.path.join(ROOT, "training", "freya-gguf_gguf", "freya-trained.gguf")
    source = max(files, key=os.path.getsize)
    if os.path.abspath(source) != os.path.abspath(model):
        shutil.move(source, model)
    print(f"Model: {model} ({os.path.getsize(model) / 1e9:.2f} GB)")

    chat_format = "qwen3.5" if "Qwen3.5" in args.base else "chatml"
    if not args.no_eval:
        step("5/6 Load into Ollama here and evaluate (before you download anything)")
        if shutil.which("ollama") is None:
            run("curl -fsSL https://ollama.com/install.sh | sh > /dev/null")
        if not ollama_ready():
            subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(30):
                if ollama_ready():
                    break
                time.sleep(1)
        run(f"npx -y tsx scripts/ollama-create.mjs --base training/freya-gguf_gguf/freya-trained.gguf --name freya-trained --format {chat_format}")
        run("npx -y tsx scripts/eval-persona.mjs freya-trained")

    step("6/6 Save")
    if args.save_to:
        if not os.path.isdir(os.path.dirname(args.save_to.rstrip("/"))):
            print(f"Can't save to {args.save_to}: mount Google Drive first (see the top of this file). The model is at {model}.")
        else:
            os.makedirs(args.save_to, exist_ok=True)
            shutil.copy2(model, os.path.join(args.save_to, "freya-trained.gguf"))
            lora = os.path.join(ROOT, "training", "freya-gguf", "lora")
            if os.path.isdir(lora):
                shutil.copytree(lora, os.path.join(args.save_to, "lora"), dirs_exist_ok=True)
            print(f"Saved to {args.save_to}/freya-trained.gguf")

    minutes = (time.time() - started) / 60
    print(f"""
Done in {minutes:.0f} min. Read the evaluation transcripts above, not just the score.

To hear it, without loading it on your laptop:
  python training/serve_remote.py --model {args.save_to or "training/freya-gguf_gguf"}/freya-trained.gguf
Then run the line it prints on your laptop, and use the blind test (npm run bakeoff) to see whether
it beats the stock 27B. Only keep it if it does.
""")


if __name__ == "__main__":
    main()
