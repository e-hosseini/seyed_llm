#!/usr/bin/env bash
# Run once on the VPS as root (and re-run after every reboot, or persist it with
# netfilter-persistent). Sandbox networks use bridges named aggsbr<N>.
#
# Docker already isolates separate bridge networks from each other, so sandboxes cannot
# reach one another or the compose network. These rules close the two remaining paths:
#   1. a sandbox talking to services on the VPS itself (reached via its bridge gateway)
#   2. a sandbox reaching the cloud metadata endpoint
set -euo pipefail

add() { # idempotent: only insert the rule if it is not already present
  local chain=$1; shift
  iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" "$@"
}

add INPUT -i 'aggsbr+' -j DROP
add DOCKER-USER -i 'aggsbr+' -d 169.254.169.254 -j DROP

echo "sandbox firewall rules in place"
