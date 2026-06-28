#!/bin/bash
# Ensures the Headroom proxy (https://github.com/headroomlabs-ai/headroom)
# is installed and running in the background for this session, so it's
# available on http://127.0.0.1:8787 if you want to point a client at it.
# Does NOT change ANTHROPIC_BASE_URL/OPENAI_BASE_URL or any other session
# behavior — starting the proxy is the only effect. Synchronous, idempotent,
# fails open: any error here just skips the proxy, it never blocks the
# session.
set -uo pipefail

# Only run in Claude Code on the web; local sessions opt in manually via
# scripts/start-proxy.sh.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PROXY_PORT="${HEADROOM_PORT:-8787}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"
LOG_DIR="${PROJECT_DIR}/.claude/logs"
LOG_FILE="${LOG_DIR}/headroom-proxy.log"
# Installed into its own venv, not system site-packages: this image has
# apt-managed Python packages (e.g. PyJWT) with no pip RECORD file, so a
# system `pip install` can fail outright trying to upgrade them.
VENV_DIR="${PROJECT_DIR}/.claude/.venv"
HEADROOM_BIN="${VENV_DIR}/bin/headroom"

is_healthy() {
  curl -s -m 2 -o /dev/null -w '%{http_code}' "${PROXY_URL}/livez" 2>/dev/null | grep -q '^200$'
}

if is_healthy; then
  exit 0
fi

mkdir -p "${LOG_DIR}" 2>/dev/null || true

if [ ! -x "${HEADROOM_BIN}" ]; then
  python3 -m venv "${VENV_DIR}" >> "${LOG_FILE}" 2>&1
  # [proxy] only, not [all]: this runs on every fresh session, and [all]
  # pulls in ML extras (torch/transformers) that take ~3min vs ~35s and
  # aren't needed to run the proxy itself.
  "${VENV_DIR}/bin/pip" install -q "headroom-ai[proxy]" >> "${LOG_FILE}" 2>&1
  if [ $? -ne 0 ] || [ ! -x "${HEADROOM_BIN}" ]; then
    echo "headroom-proxy hook: install failed, skipping proxy startup" >> "${LOG_FILE}" 2>/dev/null
    exit 0
  fi
fi

HEADROOM_UPDATE_CHECK=off nohup "${HEADROOM_BIN}" proxy --port "${PROXY_PORT}" >> "${LOG_FILE}" 2>&1 &
disown

for _ in $(seq 1 20); do
  if is_healthy; then
    exit 0
  fi
  sleep 1
done

echo "headroom-proxy hook: proxy did not become healthy within 20s" >> "${LOG_FILE}" 2>/dev/null
exit 0
