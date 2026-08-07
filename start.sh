#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

PORT="${PORT:-8766}"
echo "Starting FitPit dashboard at http://127.0.0.1:${PORT}"
exec .venv/bin/uvicorn api.main:app --host 127.0.0.1 --port "$PORT" --reload
