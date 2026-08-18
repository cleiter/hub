#!/bin/sh
# Boots the built application on the embedded database and waits for /health.
#
# Neither the unit suite nor the typechecker can see an ESM/CommonJS interop failure: vitest
# resolves named exports from CommonJS that Node's real loader refuses, so a dependency can
# type-check, pass every test, and then throw `SyntaxError: Named export ... not found` the first
# time the server actually starts. `docker-smoke` catches that too, but it builds an image first;
# this runs the same check in seconds against the output `npm run build` just produced.
set -eu

port="${PORT:-3111}"
state="$(mktemp -d)"
log="$state/boot.log"
pid=""

cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$state"
}
trap cleanup EXIT INT TERM

PORT="$port" node dist/index.js >"$log" 2>&1 &
pid=$!

attempt=0
until curl --fail --silent "http://127.0.0.1:$port/health" | grep --quiet '"ok":true'; do
  attempt=$((attempt + 1))
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "The server exited before it became healthy:"
    cat "$log"
    exit 1
  fi
  if [ "$attempt" -ge 30 ]; then
    echo "The server never reported healthy:"
    cat "$log"
    exit 1
  fi
  sleep 1
done

echo "Booted and healthy on port $port."
