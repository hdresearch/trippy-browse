#!/bin/bash
#
# launch.sh — Spawn a Lightpanda browser VM from the golden commit.
#
# Usage: ./launch.sh [commit-id]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMMIT_ID="${1:-}"

if [ -z "$COMMIT_ID" ]; then
    if [ -f "golden-commit-id.txt" ]; then
        COMMIT_ID=$(cat golden-commit-id.txt | tr -d '[:space:]')
    else
        echo "Error: No golden-commit-id.txt found. Run ./create-golden-image.sh first."
        exit 1
    fi
fi

echo "=== Launching Lightpanda Browser VM ==="
echo "  Commit: $COMMIT_ID"
echo ""

echo "[1/3] Spawning VM from commit..."
VM_ID=$(vers run-commit "$COMMIT_ID" --wait --format json 2>/dev/null | grep -oE '[a-f0-9-]{36}' | head -1)
if [ -z "$VM_ID" ]; then VM_ID=$(vers head 2>/dev/null); fi
if [ -z "$VM_ID" ]; then echo "Error: Could not spawn VM"; exit 1; fi
echo "  VM ID: $VM_ID"

echo "[2/3] Waiting for VM..."
for i in {1..15}; do
    if vers exec --ssh "$VM_ID" echo ready 2>&1 | grep -q ready; then
        echo "  VM is ready"
        break
    fi
    sleep 3
done

echo "[3/3] Starting services..."
vers exec --ssh -t 60 "$VM_ID" bash -c 'nohup /app/start.sh > /tmp/start.log 2>&1 &' 2>&1
sleep 5

vers exec --ssh -t 30 "$VM_ID" bash -c '
echo "  node:  $(pgrep node > /dev/null && echo "✓ running" || echo "✗ NOT running")"
echo "  nginx: $(pgrep nginx > /dev/null && echo "✓ running" || echo "✗ NOT running")"
' 2>&1

echo ""
echo "=== Lightpanda Browser VM Ready ==="
echo ""
echo "  VM ID: $VM_ID"
echo "  Open:  https://${VM_ID}.vm.vers.sh"
echo ""
echo "  To delete: vers delete -y $VM_ID"
echo ""
