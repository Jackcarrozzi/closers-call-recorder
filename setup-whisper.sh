#!/usr/bin/env bash
# Optional: free, local transcripts with speaker names.
#
# Builds whisper.cpp and downloads a model, then points the recorder at it.
# Only worth running on a box with real CPU to spare - on Oracle's 4-core ARM
# instance a one-hour call transcribes in roughly ten minutes with base.en.
#
#   sudo bash setup-whisper.sh            # base.en, a good default
#   sudo bash setup-whisper.sh small.en   # slower, noticeably more accurate
#
set -euo pipefail

MODEL="${1:-base.en}"
WHISPER_DIR=/opt/whisper.cpp
MODEL_DIR=/opt/whisper-models
APP_ENV=/opt/closers-recorder/.env

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash setup-whisper.sh" >&2
  exit 1
fi

echo "==> Installing build tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git cmake build-essential >/dev/null

if [[ ! -d "$WHISPER_DIR" ]]; then
  echo "==> Cloning whisper.cpp"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR" >/dev/null 2>&1
fi

echo "==> Building (uses all $(nproc) cores, takes a few minutes)"
cmake -B "$WHISPER_DIR/build" -S "$WHISPER_DIR" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$WHISPER_DIR/build" --config Release -j "$(nproc)" >/dev/null

BIN="$WHISPER_DIR/build/bin/whisper-cli"
[[ -x "$BIN" ]] || { echo "Build finished but $BIN is missing." >&2; exit 1; }
install -m 755 "$BIN" /usr/local/bin/whisper-cli

echo "==> Downloading the $MODEL model"
mkdir -p "$MODEL_DIR"
bash "$WHISPER_DIR/models/download-ggml-model.sh" "$MODEL" "$MODEL_DIR" >/dev/null
MODEL_PATH="$MODEL_DIR/ggml-$MODEL.bin"
[[ -f "$MODEL_PATH" ]] || { echo "Model download failed." >&2; exit 1; }
chmod -R a+rX "$MODEL_DIR"

if [[ -f "$APP_ENV" ]]; then
  echo "==> Switching transcripts on in $APP_ENV"
  sed -i '/^TRANSCRIBE=/d;/^WHISPER_BIN=/d;/^WHISPER_MODEL=/d' "$APP_ENV"
  {
    echo "TRANSCRIBE=local"
    echo "WHISPER_BIN=/usr/local/bin/whisper-cli"
    echo "WHISPER_MODEL=$MODEL_PATH"
  } >> "$APP_ENV"
  systemctl restart closers-recorder 2>/dev/null || true
fi

cat <<DONE

────────────────────────────────────────────────────────────
 Local transcripts are on. No API key, no per-minute cost.

 Model : $MODEL_PATH
 Binary: /usr/local/bin/whisper-cli

 Every recording now gets a .txt beside it, labelled by
 speaker, and both get uploaded to Drive together.

 Too slow, or not accurate enough? Re-run with a different
 model - tiny.en, base.en, small.en, medium.en - largest
 last. small.en is the sweet spot on a 4-core box.
────────────────────────────────────────────────────────────
DONE
