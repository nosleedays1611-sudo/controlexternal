#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 backup.tar.gz" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
ARCHIVE="$1"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "backup not found: $ARCHIVE" >&2
  exit 2
fi

mkdir -p "$DATA_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

tar -xzf "$ARCHIVE" -C "$TMP"
rm -rf "$DATA_DIR"/*
cp -a "$TMP"/. "$DATA_DIR"/

echo "restored into $DATA_DIR"
