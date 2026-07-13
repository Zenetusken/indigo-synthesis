#!/usr/bin/env bash
# Prepare for CUDA stack reboot and instruct the system to reboot.
# After login, run: pnpm llm:measure-gpu
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "=== Stopping local inference servers ==="
pkill -f 'llama-server' 2>/dev/null || true

echo "=== Current NVIDIA state (expected mismatch pre-reboot) ==="
echo "loaded module: $(cat /sys/module/nvidia/version 2>/dev/null || echo none)"
nvidia-smi 2>&1 | head -8 || true
dkms status 2>/dev/null | rg nvidia || true

echo
echo "=== After reboot, run this exactly ==="
cat <<'EOF'
cd ~/project/indigo-synthesis
git checkout feat/llm-modular-inference-layer
pnpm llm:measure-gpu
# Expected: nvidia-smi OK, CUDA llama-server, live availableRate=1.0, GPU memory in use
EOF

MARKER="$HOME/.indigo-llm-post-reboot-measure"
cat >"$MARKER" <<EOF
# Created $(date -Is)
# After reboot, from indigo-synthesis:
#   pnpm llm:measure-gpu
EOF
echo "Wrote reminder: $MARKER"

echo
echo "Rebooting in 5 seconds (Ctrl+C to abort)..."
sleep 5

if sudo -n reboot 2>/dev/null; then
  exit 0
fi

echo "Passwordless sudo reboot unavailable."
echo "Run manually:"
echo "  sudo reboot"
echo "Then after login: pnpm llm:measure-gpu"
exit 1
