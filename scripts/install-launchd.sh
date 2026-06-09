#!/usr/bin/env bash
# flex-sync 자동 스케줄(launchd) 설치/제거
# 설치:  bash scripts/install-launchd.sh
# 제거:  bash scripts/install-launchd.sh uninstall
set -euo pipefail

LABEL="uk.wooo.h-mirror.flex-sync"
SRC="$(cd "$(dirname "$0")" && pwd)/launchd/${LABEL}.plist"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$DEST" 2>/dev/null || true
  rm -f "$DEST"
  echo "✓ 제거 완료"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "✓ 설치 완료 — 매일 09:30 자동 실행"
echo "  지금 한 번 테스트:  launchctl kickstart -k gui/$(id -u)/${LABEL}"
echo "  로그:               tail -f scripts/flex-sync.log"
echo "  제거:               bash scripts/install-launchd.sh uninstall"
