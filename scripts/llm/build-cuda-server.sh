#!/usr/bin/env bash
# Build llama-server with CUDA for Qwen3.5 (qwen35) on this host.
set -euo pipefail

LLAMA_DIR="${INDIGO_LLAMA_SRC:-$HOME/project/llama.cpp-indigo}"
# RTX 40-series Ada is sm_89 (PCI 2786 family on this machine).
ARCHS="${CMAKE_CUDA_ARCHITECTURES:-89}"

if [[ ! -d "$LLAMA_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
else
  git -C "$LLAMA_DIR" fetch --depth 1 origin master 2>/dev/null || true
  git -C "$LLAMA_DIR" pull --ff-only 2>/dev/null || true
fi

echo "=== nvidia-smi (must succeed before CUDA runtime use) ==="
nvidia-smi

export PATH="/usr/local/cuda/bin:${PATH:-}"
export CUDACXX="${CUDACXX:-/usr/local/cuda/bin/nvcc}"
export CUDAToolkit_ROOT="${CUDAToolkit_ROOT:-/usr/local/cuda}"

cd "$LLAMA_DIR"
rm -rf build
echo "Configuring CUDA build ARCHS=$ARCHS CUDACXX=$CUDACXX"
cmake -B build \
  -DGGML_CUDA=ON \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_ARCHITECTURES="$ARCHS" \
  -DCMAKE_CUDA_COMPILER="$CUDACXX"

cmake --build build --config Release -j"$(nproc)" --target llama-server
ls -la build/bin/llama-server
./build/bin/llama-server --version || true
echo "Built: $LLAMA_DIR/build/bin/llama-server"
echo "Export: INDIGO_LLAMA_SERVER=$LLAMA_DIR/build/bin/llama-server"
