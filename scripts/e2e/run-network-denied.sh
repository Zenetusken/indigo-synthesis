#!/usr/bin/env bash
# Run the default browser suite in a network namespace that contains only loopback.
# A private Unix-socket bridge exposes only the already-guarded host PostgreSQL port.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "ERROR: $*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

assert_namespace_topology() {
  local non_loopback_links
  non_loopback_links="$(ip -o link show | awk -F': ' '$2 !~ /^lo(@|$)/ { print $2 }')"
  if [[ -n "$non_loopback_links" ]]; then
    fail "network-denied namespace unexpectedly contains: $non_loopback_links"
  fi
  if [[ -n "$(ip -4 route show default)" || -n "$(ip -6 route show default)" ]]; then
    fail "network-denied namespace unexpectedly has a default route"
  fi

  node --input-type=module <<'NODE'
import { createServer } from 'node:http'
import { connect } from 'node:net'

const server = createServer((_request, response) => response.end('loopback-ok'))
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing probe port')
  const response = await fetch(`http://127.0.0.1:${address.port}`, {
    signal: AbortSignal.timeout(2_000),
  })
  if ((await response.text()) !== 'loopback-ok') {
    throw new Error('loopback HTTP probe returned the wrong response')
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

await new Promise((resolve, reject) => {
  const socket = connect({ host: '1.1.1.1', port: 443 })
  const timeout = setTimeout(() => {
    socket.destroy()
    reject(new Error('direct public-IP probe timed out instead of failing unreachable'))
  }, 2_000)
  socket.once('connect', () => {
    clearTimeout(timeout)
    socket.destroy()
    reject(new Error('network namespace unexpectedly reached a public IP'))
  })
  socket.once('error', (error) => {
    clearTimeout(timeout)
    if (!['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'].includes(error.code)) {
      reject(new Error(`public-IP probe failed ambiguously: ${error.code ?? error.message}`))
      return
    }
    resolve()
  })
})
NODE

  echo "Network boundary verified: loopback available; no other interface or route."
}

wait_for_database_bridge() {
  node --input-type=module <<'NODE'
import { connect } from 'node:net'

const host = process.env.INDIGO_NETWORK_DENIED_DB_HOST
const port = Number(process.env.INDIGO_NETWORK_DENIED_DB_PORT)
const deadline = Date.now() + 5_000

while (Date.now() < deadline) {
  const connected = await new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.setTimeout(250)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
  if (connected) process.exit(0)
  await new Promise((resolve) => setTimeout(resolve, 100))
}

throw new Error(`PostgreSQL bridge did not become ready on ${host}:${port}`)
NODE
}

run_inside_namespace() {
  [[ -n "${INDIGO_NETWORK_DENIED_DB_FAMILY:-}" ]] || fail "database family is missing"
  [[ -n "${INDIGO_NETWORK_DENIED_DB_HOST:-}" ]] || fail "database host is missing"
  [[ -n "${INDIGO_NETWORK_DENIED_DB_PORT:-}" ]] || fail "database port is missing"
  [[ -S "${INDIGO_NETWORK_DENIED_DB_SOCKET:-}" ]] || fail "database bridge is missing"

  ip link set lo up
  assert_namespace_topology

  local listen_address
  if [[ "$INDIGO_NETWORK_DENIED_DB_FAMILY" == "4" ]]; then
    listen_address="TCP4-LISTEN:${INDIGO_NETWORK_DENIED_DB_PORT},bind=127.0.0.1,reuseaddr,fork"
  elif [[ "$INDIGO_NETWORK_DENIED_DB_FAMILY" == "6" ]]; then
    listen_address="TCP6-LISTEN:${INDIGO_NETWORK_DENIED_DB_PORT},bind=[::1],reuseaddr,fork"
  else
    fail "unsupported database address family"
  fi

  socat "$listen_address" "UNIX-CONNECT:${INDIGO_NETWORK_DENIED_DB_SOCKET}" \
    >"${INDIGO_NETWORK_DENIED_CHILD_LOG}" 2>&1 &
  namespace_listener_pid=$!
  trap 'kill "$namespace_listener_pid" 2>/dev/null || true; wait "$namespace_listener_pid" 2>/dev/null || true' EXIT

  wait_for_database_bridge
  echo "PostgreSQL bridge verified on ${INDIGO_NETWORK_DENIED_DB_HOST}:${INDIGO_NETWORK_DENIED_DB_PORT}."
  bash scripts/e2e/run.sh default
  assert_namespace_topology
}

if [[ "${1:-}" == "--namespace-child" ]]; then
  shift
  [[ $# -eq 0 ]] || fail "the namespace child accepts no arguments"
  require_command ip
  require_command node
  require_command socat
  run_inside_namespace
  exit 0
fi

[[ $# -eq 0 ]] || fail "Usage: scripts/e2e/run-network-denied.sh"
require_command awk
require_command ip
require_command node
require_command socat
require_command unshare

endpoint="$({
  node --env-file-if-exists=.env.local --env-file-if-exists=.env.e2e.local \
    --input-type=module <<'NODE'
const administration = process.env.DATABASE_URL
const target = process.env.E2E_DATABASE_URL
if (!administration || !target) {
  throw new Error('DATABASE_URL and E2E_DATABASE_URL are required')
}

const administrationUrl = new URL(administration)
const targetUrl = new URL(target)
const effectivePort = (url) => url.port || '5432'
if (
  administrationUrl.hostname !== targetUrl.hostname ||
  effectivePort(administrationUrl) !== effectivePort(targetUrl)
) {
  throw new Error('DATABASE_URL and E2E_DATABASE_URL must share one loopback endpoint')
}

const host = targetUrl.hostname
if (host === '127.0.0.1') {
  process.stdout.write(`4\t127.0.0.1\t${effectivePort(targetUrl)}`)
} else if (host === '[::1]') {
  process.stdout.write(`6\t::1\t${effectivePort(targetUrl)}`)
} else {
  throw new Error('the network-denied proof requires a literal loopback PostgreSQL host')
}
NODE
} 2>&1)" || fail "$endpoint"

IFS=$'\t' read -r database_family database_host database_port <<<"$endpoint"
[[ "$database_port" =~ ^[0-9]+$ ]] || fail "invalid PostgreSQL port"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/indigo-network-denied.XXXXXX")"
chmod 700 "$temporary_directory"
bridge_socket="$temporary_directory/postgres.sock"
parent_log="$temporary_directory/parent-bridge.log"
child_log="$temporary_directory/child-bridge.log"
bridge_pid=""

cleanup() {
  if [[ -n "$bridge_pid" ]]; then
    kill "$bridge_pid" 2>/dev/null || true
    wait "$bridge_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$database_family" == "4" ]]; then
  database_destination="TCP4:127.0.0.1:${database_port},connect-timeout=5"
else
  database_destination="TCP6:[::1]:${database_port},connect-timeout=5"
fi

socat "UNIX-LISTEN:${bridge_socket},fork,mode=0600" "$database_destination" \
  >"$parent_log" 2>&1 &
bridge_pid=$!
for _ in $(seq 1 50); do
  [[ -S "$bridge_socket" ]] && break
  kill -0 "$bridge_pid" 2>/dev/null || {
    sed -n '1,120p' "$parent_log" >&2
    fail "PostgreSQL bridge exited before creating its private socket"
  }
  sleep 0.1
done
[[ -S "$bridge_socket" ]] || fail "PostgreSQL bridge socket was not created"

export INDIGO_NETWORK_DENIED_DB_FAMILY="$database_family"
export INDIGO_NETWORK_DENIED_DB_HOST="$database_host"
export INDIGO_NETWORK_DENIED_DB_PORT="$database_port"
export INDIGO_NETWORK_DENIED_DB_SOCKET="$bridge_socket"
export INDIGO_NETWORK_DENIED_CHILD_LOG="$child_log"

echo "Starting destructive, guarded default E2E reset/run in a loopback-only namespace."
if ! unshare --user --map-root-user --net -- "$0" --namespace-child; then
  [[ -s "$parent_log" ]] && sed -n '1,120p' "$parent_log" >&2
  [[ -s "$child_log" ]] && sed -n '1,120p' "$child_log" >&2
  fail "network-denied E2E run failed"
fi

echo "Outbound-network-denied acceptance run passed."
