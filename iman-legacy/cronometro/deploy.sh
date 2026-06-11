#!/usr/bin/env bash
# Deploy CRONOMETRO to VPS 204.168.225.7
# Syncs source, builds on VPS (no cross-compile needed).
# Usage: ./deploy.sh [live]   — pass "live" to disable DRY_RUN

set -e
VPS="root@204.168.225.7"
REMOTE_DIR="/root/iman/cronometro"

DRY_RUN_VAL="true"
[[ "$1" == "live" ]] && DRY_RUN_VAL="false"

echo "Syncing source to $VPS:$REMOTE_DIR..."
ssh "$VPS" "mkdir -p $REMOTE_DIR"
rsync -avz --exclude='target/' --exclude='.cargo/' . "$VPS:$REMOTE_DIR/"

echo "Building on VPS..."
ssh "$VPS" "cd $REMOTE_DIR && /root/.cargo/bin/cargo build --release 2>&1 | tail -3"

echo "Installing service (DRY_RUN=$DRY_RUN_VAL)..."
ssh "$VPS" "
  sed -i 's/DRY_RUN=.*/DRY_RUN=$DRY_RUN_VAL/' $REMOTE_DIR/iman-cronometro.service
  cp $REMOTE_DIR/iman-cronometro.service /etc/systemd/system/iman-cronometro.service
  systemctl daemon-reload
  systemctl enable iman-cronometro
  systemctl restart iman-cronometro
  sleep 2
  systemctl status iman-cronometro --no-pager
"
echo "Done. Tail logs: ssh $VPS 'journalctl -u iman-cronometro -f'"
