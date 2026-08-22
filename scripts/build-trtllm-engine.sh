#!/usr/bin/env bash
#
# Build an INT4-AWQ TensorRT-LLM engine for a Jetson Orin Nano Super.
#
# This is the path that uses the most of the hardware. Ollama runs GGUF weights
# through llama.cpp's CUDA kernels, which are generic across GPUs; TensorRT-LLM
# compiles a plan for this exact SM 8.7 device, fusing layers and selecting
# kernels ahead of time, and INT4-AWQ weights let the Ampere Tensor cores do the
# matmuls at four bits per weight. That roughly halves the weight footprint
# against q8_0 GGUF, which on 8 GB of unified memory is the difference between
# "fits with a small context" and "fits with room to spare".
#
# Run it INSIDE the TensorRT-LLM container on the Jetson — it needs the local
# CUDA driver and the target GPU present, so the engine cannot be cross-built on
# a workstation:
#
#   docker run --rm -it --runtime nvidia \
#     -v "$PWD/trtllm_models:/models" \
#     -v "$PWD/trtllm_engines:/engines" \
#     -v "$PWD/scripts:/scripts" \
#     nvcr.io/nvidia/tensorrt-llm/release:latest \
#     bash /scripts/build-trtllm-engine.sh
#
# Then serve it with docker-compose.tensorrt.yml and point the plugin at
# http://<jetson>:8000 with backend = tensorrt-llm.
#
# The exact quantize/build entry points move between TensorRT-LLM releases.
# If a step is missing, check the examples/ tree in the container image.

set -euo pipefail

# Hugging Face repo or a local checkpoint directory.
MODEL_ID="${MODEL_ID:-google/gemma-3-4b-it}"
MODEL_DIR="${MODEL_DIR:-/models/$(basename "${MODEL_ID}")}"
CHECKPOINT_DIR="${CHECKPOINT_DIR:-/models/checkpoints/$(basename "${MODEL_ID}")-int4-awq}"
ENGINE_DIR="${ENGINE_DIR:-/engines/$(basename "${MODEL_ID}")-int4-awq}"

# Must match, or exceed, the plugin's "GPU context window" (num_ctx). Unlike
# Ollama, asking a TensorRT-LLM engine for more than it was built with is a
# request error, not a silent fallback.
MAX_SEQ_LEN="${MAX_SEQ_LEN:-8192}"
MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-1}"
# Orin Ampere. Set explicitly so a build on a different host cannot silently
# target the wrong architecture.
CUDA_ARCH="${CUDA_ARCH:-87}"

echo "==> Model:      ${MODEL_ID}"
echo "==> Checkpoint: ${CHECKPOINT_DIR}"
echo "==> Engine:     ${ENGINE_DIR}"
echo "==> max_seq_len ${MAX_SEQ_LEN}, SM ${CUDA_ARCH}"

if ! command -v trtllm-build > /dev/null 2>&1; then
  echo "trtllm-build not found. Run this inside the TensorRT-LLM container." >&2
  exit 1
fi

if [ ! -d "${MODEL_DIR}" ]; then
  echo "==> Downloading ${MODEL_ID}"
  # Gated repos need HF_TOKEN in the environment.
  huggingface-cli download "${MODEL_ID}" --local-dir "${MODEL_DIR}"
fi

# AWQ keeps the salient weight channels at higher precision, so INT4 costs far
# less quality than round-to-nearest would. Calibration is what finds them, and
# it is the slow step — expect tens of minutes on an Orin.
if [ ! -d "${CHECKPOINT_DIR}" ]; then
  echo "==> Quantizing to INT4-AWQ (this is the slow step)"
  python3 /app/tensorrt_llm/examples/quantization/quantize.py \
    --model_dir "${MODEL_DIR}" \
    --output_dir "${CHECKPOINT_DIR}" \
    --dtype float16 \
    --qformat int4_awq \
    --awq_block_size 128 \
    --calib_size 32
fi

echo "==> Building the engine for SM ${CUDA_ARCH}"
TRTLLM_CUDA_ARCHS="${CUDA_ARCH}" trtllm-build \
  --checkpoint_dir "${CHECKPOINT_DIR}" \
  --output_dir "${ENGINE_DIR}" \
  --gemm_plugin auto \
  --max_batch_size "${MAX_BATCH_SIZE}" \
  --max_seq_len "${MAX_SEQ_LEN}" \
  --use_paged_context_fmha enable \
  --kv_cache_type paged

echo
echo "Engine written to ${ENGINE_DIR}"
echo "Serve it with:"
echo "  trtllm-serve ${ENGINE_DIR} --host 0.0.0.0 --port 8000 --max_seq_len ${MAX_SEQ_LEN}"
echo
echo "Then in the plugin configuration set:"
echo "  backend = tensorrt-llm"
echo "  baseUrl = http://<jetson-host>:8000"
echo "  model   = the id reported by GET /v1/models"
echo "  numCtx  = ${MAX_SEQ_LEN} or lower"
