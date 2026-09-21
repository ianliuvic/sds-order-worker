#!/usr/bin/env bash
set -euo pipefail

# 平时不需要 X；只有 POST /api/browser-mode/login 时服务自己拉起 Xvfb/x11vnc/websockify。
mkdir -p "${STORAGE_PATH}" "${PROFILE_PATH}" "${STORAGE_PATH}/shots"
rm -f "${PROFILE_PATH}/SingletonCookie" "${PROFILE_PATH}/SingletonLock" "${PROFILE_PATH}/SingletonSocket" || true

exec node src/server.js
