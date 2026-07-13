#!/usr/bin/env bash
# Build llama-server with CUDA for Qwen3.5 (qwen35) on this host.
set -euo pipefail

LLAMA_DIR="${INDIGO_LLAMA_SRC:-$HOME/project/llama.cpp-indigo}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="$ROOT/llm/runtime/llama-cpp.lock.json"
REPOSITORY="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).repository" "$LOCK")"
COMMIT="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).commit" "$LOCK")"
LOCKED_ARCHS="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).cudaArchitectures.join(';')" "$LOCK")"
EXPECTED_BINARY_SHA256="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).serverBinarySha256" "$LOCK")"
EXPECTED_BINARY_SIZE="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).serverBinarySizeBytes" "$LOCK")"
# RTX 40-series Ada is sm_89. The supported build is locked to this architecture.
ARCHS="${CMAKE_CUDA_ARCHITECTURES:-$LOCKED_ARCHS}"

if [[ "$ARCHS" != "$LOCKED_ARCHS" ]]; then
  echo "FATAL: CMAKE_CUDA_ARCHITECTURES=$ARCHS differs from runtime lock $LOCKED_ARCHS" >&2
  exit 2
fi

if [[ ! -d "$LLAMA_DIR/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$REPOSITORY" "$LLAMA_DIR"
fi
git -C "$LLAMA_DIR" fetch --depth 1 origin "$COMMIT"
git -C "$LLAMA_DIR" checkout --detach "$COMMIT"
ACTUAL_COMMIT="$(git -C "$LLAMA_DIR" rev-parse HEAD)"
if [[ "$ACTUAL_COMMIT" != "$COMMIT" ]]; then
  echo "FATAL: checked out $ACTUAL_COMMIT; expected pinned commit $COMMIT" >&2
  exit 2
fi
if [[ -n "$(git -C "$LLAMA_DIR" status --porcelain --untracked-files=all)" ]]; then
  echo "FATAL: llama.cpp checkout is dirty; refuse an unattestable build" >&2
  git -C "$LLAMA_DIR" status --short >&2
  exit 2
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
ACTUAL_BINARY_SHA256="$(sha256sum build/bin/llama-server | cut -d ' ' -f 1)"
ACTUAL_BINARY_SIZE="$(stat -c '%s' build/bin/llama-server)"
if [[ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" || "$ACTUAL_BINARY_SIZE" != "$EXPECTED_BINARY_SIZE" ]]; then
  echo "FATAL: built binary does not match the host-pinned runtime lock" >&2
  echo "  actual sha256=$ACTUAL_BINARY_SHA256 size=$ACTUAL_BINARY_SIZE" >&2
  echo "  locked sha256=$EXPECTED_BINARY_SHA256 size=$EXPECTED_BINARY_SIZE" >&2
  exit 2
fi
while IFS=$'\t' read -r LIBRARY_FILENAME LIBRARY_SHA256 LIBRARY_SIZE; do
  LIBRARY_PATH="build/bin/$LIBRARY_FILENAME"
  ACTUAL_LIBRARY_SHA256="$(sha256sum "$LIBRARY_PATH" | cut -d ' ' -f 1)"
  ACTUAL_LIBRARY_SIZE="$(stat -c '%s' "$LIBRARY_PATH")"
  if [[ "$ACTUAL_LIBRARY_SHA256" != "$LIBRARY_SHA256" || "$ACTUAL_LIBRARY_SIZE" != "$LIBRARY_SIZE" ]]; then
    echo "FATAL: $LIBRARY_FILENAME does not match the host-pinned runtime lock" >&2
    exit 2
  fi
done < <(
  node -e "const lock=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); for (const lib of lock.runtimeLibraries) console.log([lib.filename,lib.sha256,lib.sizeBytes].join('\\t'))" "$LOCK"
)
echo "Built: $LLAMA_DIR/build/bin/llama-server"
echo "Pinned llama.cpp commit: $ACTUAL_COMMIT"
echo "Export: INDIGO_LLAMA_SERVER=$LLAMA_DIR/build/bin/llama-server"
