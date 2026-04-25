#!/bin/bash
#
# create-golden-image.sh
# Creates a golden VM commit with Chrome (non-headless), Xvfb, x11vnc,
# websockify, nginx, and the browser control app pre-installed.
#
# The commit ID is written to golden-commit-id.txt.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Creating Golden Browser VM Image ==="
echo ""

# Step 1: Boot a default VM
echo "[1/6] Starting base VM..."
RUN_OUTPUT=$(vers run --wait --format json 2>&1)
VM_ID=$(echo "$RUN_OUTPUT" | grep -oE '[a-f0-9-]{36}' | head -1)

if [ -z "$VM_ID" ]; then
    VM_ID=$(vers head 2>/dev/null)
fi

if [ -z "$VM_ID" ]; then
    echo "Error: Could not determine VM ID"
    echo "$RUN_OUTPUT"
    exit 1
fi

echo "  VM ID: $VM_ID"

# Step 2: Wait for VM to accept SSH
echo "[2/6] Waiting for VM to be ready..."
for i in {1..30}; do
    if vers exec --ssh "$VM_ID" echo ready 2>&1 | grep -q ready; then
        echo "  VM is ready"
        break
    fi
    echo "  Waiting... ($i/30)"
    sleep 5
done

# Step 3: Upload all files
echo "[3/6] Uploading files to VM..."
vers exec --ssh "$VM_ID" mkdir -p /app 2>&1

for f in control-server.js index.html start.sh vm-setup.sh; do
    echo "  Uploading $f..."
    vers copy "$VM_ID" "$SCRIPT_DIR/$f" "/app/$f" 2>&1 | grep -v "^$" || true
done

echo "  Uploading nginx.conf..."
# nginx sites-available may not exist yet; upload to /app first
vers copy "$VM_ID" "$SCRIPT_DIR/nginx.conf" "/app/nginx-site.conf" 2>&1 | grep -v "^$" || true

# Step 4: Run the setup script
echo "[4/6] Running setup inside VM (this takes several minutes)..."
vers exec --ssh "$VM_ID" bash /app/vm-setup.sh 2>&1 | tail -20

# Step 5: Move nginx config into place
echo "[5/6] Configuring nginx..."
vers exec --ssh "$VM_ID" cp /app/nginx-site.conf /etc/nginx/sites-available/default 2>&1
vers exec --ssh "$VM_ID" nginx -t 2>&1

# Step 6: Commit
echo "[6/6] Committing golden image..."
COMMIT_OUTPUT=$(vers commit create "$VM_ID" --format json 2>&1)
echo "  $COMMIT_OUTPUT"

COMMIT_ID=$(echo "$COMMIT_OUTPUT" | grep -oE '[a-f0-9-]{36}' | head -1)

if [ -z "$COMMIT_ID" ]; then
    echo "Error: Could not extract commit ID"
    exit 1
fi

echo "$COMMIT_ID" > golden-commit-id.txt

echo ""
echo "=== Golden Image Created ==="
echo "  Commit ID:  $COMMIT_ID"
echo "  Saved to:   golden-commit-id.txt"
echo ""
echo "Next: ./launch.sh to start the browser VM"
echo ""

# Clean up build VM
echo "Cleaning up build VM..."
vers delete -y "$VM_ID" 2>/dev/null || true

echo "Done."
