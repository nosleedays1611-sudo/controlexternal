#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/external-remote-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

tar -C "$DATA_DIR" -czf "$OUT" .
sha256sum "$OUT" > "$OUT.sha256"

echo "$OUT"
