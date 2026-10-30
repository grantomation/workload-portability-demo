#!/usr/bin/env bash
# Simulate a cluster / VM-power-on hook telling the load balancer to switch.
# Use this in a post-power-on Ansible task, a kubevirt hook, or by hand.
#
#   ./trigger.sh 2                 # switch to node position 2
#   ./trigger.sh 3 http://laptop:8080
#   GLB_URL=http://<lb-host>:8080 ./trigger.sh 4
set -euo pipefail
POS="${1:?usage: trigger.sh <position> [glb-url]}"
URL="${2:-${GLB_URL:-http://localhost:8080}}"
curl -fsS -X POST "$URL/api/activate" \
  -H 'Content-Type: application/json' \
  -d "{\"position\": $POS}" && echo
