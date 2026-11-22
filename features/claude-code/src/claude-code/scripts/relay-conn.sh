#!/usr/bin/env bash
# One relay connection (spawned by socat per client). stdin/stdout are the socket.
# Protocol: first line "<secret> <cmd>", where cmd is:
#   list   -> listening TCP ports, one "port addr" per line (addr: IPv4 or ::1)
#   meta   -> ~/.panem/pod.json (or /workspace/.panem/pod.json on pods from before the rename)
#   <port> -> raw byte pipe to that port on the pod's own loopback
set -uo pipefail
STATE="${PANEM_STATE_DIR:-$HOME/.panem}"
[ -f "$STATE/pod.json" ] || STATE=/workspace/.panem
RELAY_PORT="${PANEM_RELAY_PORT:-7699}"

IFS=' ' read -r -t 5 secret cmd || exit 0
cmd="${cmd%$'\r'}"
[ -n "${PANEM_RELAY_SECRET:-}" ] && [ "$secret" = "$PANEM_RELAY_SECRET" ] || exit 0

# /proc/net/tcp addresses are little-endian hex, e.g. 0100007F:1435 = 127.0.0.1:5173
hex_ip4() {
  local h=$1
  printf '%d.%d.%d.%d' "0x${h:6:2}" "0x${h:4:2}" "0x${h:2:2}" "0x${h:0:2}"
}

# Prints "port connect-address" for every LISTEN socket (state 0A).
listeners() {
  local local_addr st ip port
  if [ -r /proc/net/tcp ]; then
    while read -r _ local_addr _ st _; do
      [ "$st" = 0A ] || continue
      ip="${local_addr%%:*}"
      port=$((16#${local_addr##*:}))
      if [ "$ip" = 00000000 ]; then echo "$port 127.0.0.1"; else echo "$port $(hex_ip4 "$ip")"; fi
    done < <(tail -n +2 /proc/net/tcp)
  fi
  if [ -r /proc/net/tcp6 ]; then
    while read -r _ local_addr _ st _; do
      [ "$st" = 0A ] || continue
      ip="${local_addr%%:*}"
      port=$((16#${local_addr##*:}))
      case "$ip" in
        00000000000000000000000000000000) echo "$port ::" ;;
        00000000000000000000000001000000) echo "$port ::1" ;;
        0000000000000000FFFF0000*) echo "$port $(hex_ip4 "${ip:24:8}")" ;;
      esac
    done < <(tail -n +2 /proc/net/tcp6)
  fi
}

case "$cmd" in
  list)
    # One line per port; IPv4 listeners win over IPv6 for the same port.
    listeners | awk -v skip="$RELAY_PORT" '$1 != skip && !seen[$1]++'
    ;;
  meta)
    cat "$STATE/pod.json" 2>/dev/null || echo '{}'
    ;;
  *)
    [[ "$cmd" =~ ^[0-9]{1,5}$ ]] || exit 0
    [ "$cmd" != "$RELAY_PORT" ] || exit 0
    addr="$(listeners | awk -v p="$cmd" '$1 == p { print $2; exit }')"
    case "$addr" in
      "") exit 0 ;;
      "::" | "::1") exec socat - "TCP6:[::1]:$cmd" ;;
      *) exec socat - "TCP4:$addr:$cmd" ;;
    esac
    ;;
esac
