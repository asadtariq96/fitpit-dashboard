#!/usr/bin/env bash
# Run on VPS after cloning: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

.venv/bin/pip install -q -U pip
.venv/bin/pip install -q -r requirements.txt

systemctl --user daemon-reload
systemctl --user enable fitpit-dashboard.service
systemctl --user restart fitpit-dashboard.service

sleep 2
echo "Deployed. Health:"
curl -sf http://127.0.0.1:3003/api/health || { echo "Health check failed"; exit 1; }
