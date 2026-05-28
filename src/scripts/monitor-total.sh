#!/usr/bin/env bash
# monitor-total.sh — kill loop if total system value drops below baseline

BASELINE=2281.97
STOP_THRESHOLD=2181.97  # baseline minus $100 buffer (1 rebalance event)
LOOP_PID_FILE="logs/loop.pid"
LOG="logs/monitor-total.log"
CHECK_INTERVAL=90  # seconds between checks

cd "$(dirname "$0")/../.." || exit 1

log() {
  echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"
}

log "Monitor started. Baseline=\$$BASELINE Stop=\$$STOP_THRESHOLD"

while true; do
  # Check if loop is still alive
  if [ -f "$LOOP_PID_FILE" ]; then
    LOOP_PID=$(cat "$LOOP_PID_FILE")
    if ! kill -0 "$LOOP_PID" 2>/dev/null; then
      log "Loop PID $LOOP_PID no longer running. Exiting monitor."
      exit 0
    fi
  else
    log "No PID file found. Exiting monitor."
    exit 0
  fi

  # Get current total
  SNAPSHOT=$(DOTENV_CONFIG_PATH=.env.redemptionarc npx tsx src/scripts/snapshot.ts 2>/dev/null)
  TOTAL=$(echo "$SNAPSHOT" | grep -A2 "SYSTEM TOTAL" | grep -oE '\$[0-9]+\.[0-9]+' | tr -d '$' | head -1)

  if [ -z "$TOTAL" ]; then
    log "WARN: Could not parse total from snapshot. Skipping."
    sleep "$CHECK_INTERVAL"
    continue
  fi

  USDC=$(echo "$SNAPSHOT" | grep "USDC:" | head -1 | grep -oE '\$[0-9]+\.[0-9]+' | tr -d '$')
  TICK=$(echo "$SNAPSHOT" | grep "tick:" | head -1 | grep -oE '[0-9]{4,6}' | head -1)

  log "Total=\$$TOTAL | USDC=\$$USDC | Tick=$TICK"

  # Check if below stop threshold
  IS_BELOW=$(echo "$TOTAL < $STOP_THRESHOLD" | bc -l)
  if [ "$IS_BELOW" -eq 1 ]; then
    log "STOP TRIGGERED: Total \$$TOTAL < threshold \$$STOP_THRESHOLD"
    log "Killing loop PID $LOOP_PID..."
    kill -9 "$LOOP_PID" 2>/dev/null
    pkill -9 -f "flash-deep-vol" 2>/dev/null
    log "Loop killed. Final total: \$$TOTAL. Net from baseline: \$$(echo "$TOTAL - $BASELINE" | bc -l)"
    exit 1
  fi

  NET=$(echo "$TOTAL - $BASELINE" | bc -l)
  log "  NET from baseline: \$$NET — OK"

  sleep "$CHECK_INTERVAL"
done
