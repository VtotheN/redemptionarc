#!/bin/bash
# Monitor 500 cycles. Report every 50. Stop loop if P&L negative.

LOG="/Users/velon/Desktop/redemptionarc/logs/prod-corrected.log"
MLOG="/Users/velon/Desktop/redemptionarc/logs/monitor-500.log"
PID_FILE="/Users/velon/Desktop/redemptionarc/logs/loop.pid"
cd /Users/velon/Desktop/redemptionarc

BASELINE_USDC=137.687728
BASELINE_CYCLE=58
TARGET_CYCLE=558
LAST_REPORT=0

echo "[MONITOR] START $(date -u +%H:%M:%S) baseline=\$${BASELINE_USDC} cycle=${BASELINE_CYCLE} target=${TARGET_CYCLE}" | tee -a "$MLOG"

while true; do
  CURRENT_CYCLE=$(grep "loop #" "$LOG" | tail -1 | grep -o 'total=[0-9]*' | grep -o '[0-9]*')
  [ -z "$CURRENT_CYCLE" ] && sleep 3 && continue

  # Every 50 cycles report
  REPORT_MARK=$(( (CURRENT_CYCLE / 50) * 50 ))
  if [ "$REPORT_MARK" -gt "$LAST_REPORT" ] && [ "$REPORT_MARK" -ge "$((BASELINE_CYCLE + 50))" ]; then
    LAST_REPORT=$REPORT_MARK
    CURRENT_USDC=$(DOTENV_CONFIG_PATH=.env.redemptionarc npx tsx src/scripts/snapshot.ts 2>/dev/null | grep "USDC:" | head -1 | grep -oP '\$[\d.]+' | tr -d '$')
    TICK=$(DOTENV_CONFIG_PATH=.env.redemptionarc npx tsx src/scripts/snapshot.ts 2>/dev/null | grep "tick:" | grep -oP '\d+' | head -1)
    CYCLES_DONE=$((CURRENT_CYCLE - BASELINE_CYCLE))
    DELTA=$(echo "$CURRENT_USDC - $BASELINE_USDC" | bc)
    CASHNET_LAST=$(grep "loop #" "$LOG" | tail -5 | grep -oP 'cashNet=\$[\d.]+' | grep -oP '[\d.]+' | tail -1)
    echo "[MONITOR] cycle=${CURRENT_CYCLE} (+${CYCLES_DONE}) USDC=\$${CURRENT_USDC} delta=\$${DELTA} tick=${TICK} cashNet=\$${CASHNET_LAST} $(date -u +%H:%M:%S)" | tee -a "$MLOG"

    # Check if P&L negative (USDC dropped more than 10 from baseline after at least 100 cycles)
    if [ "$CYCLES_DONE" -ge 100 ]; then
      IS_NEG=$(echo "$DELTA < -10" | bc)
      if [ "$IS_NEG" -eq 1 ]; then
        echo "[MONITOR] STOP — P&L negative: delta=\$${DELTA} after ${CYCLES_DONE} cycles. Killing loop." | tee -a "$MLOG"
        kill $(cat "$PID_FILE" 2>/dev/null) 2>/dev/null
        exit 1
      fi
    fi
  fi

  # Check if reached target
  if [ "$CURRENT_CYCLE" -ge "$TARGET_CYCLE" ]; then
    CURRENT_USDC=$(DOTENV_CONFIG_PATH=.env.redemptionarc npx tsx src/scripts/snapshot.ts 2>/dev/null | grep "USDC:" | head -1 | grep -oP '\$[\d.]+' | tr -d '$')
    DELTA=$(echo "$CURRENT_USDC - $BASELINE_USDC" | bc)
    CYCLES_DONE=$((CURRENT_CYCLE - BASELINE_CYCLE))
    echo "[MONITOR] DONE 500 cycles — USDC=\$${CURRENT_USDC} delta=\$${DELTA} cycles=${CYCLES_DONE} $(date -u +%H:%M:%S)" | tee -a "$MLOG"
    echo "[MONITOR] VERDICT: $([ $(echo "$DELTA > 0" | bc) -eq 1 ] && echo PROFITABLE || echo NEGATIVE)" | tee -a "$MLOG"
    exit 0
  fi

  sleep 4
done
