#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

pip install -q -r requirements.txt

exec headroom proxy "$@"
