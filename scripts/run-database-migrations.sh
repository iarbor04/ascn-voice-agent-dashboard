#!/bin/sh
set -eu

node docker-entry.mjs &
server_pid=$!

stop_server() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap stop_server EXIT INT TERM

attempt=0
while [ "$attempt" -lt 90 ]; do
  if node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    echo "Database schema and legacy import completed"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "Database migration health check timed out" >&2
exit 1
