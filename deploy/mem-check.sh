# shellcheck shell=bash
# Runtime memory check for `deploy.sh up` (sourced). PASS/FAIL only. Tests: deploy/tests/mem-check.test.sh
# The stack's worst case is its compose mem_limit values (hard caps): postgres + redis + srh + srh-tls + app, plus the
# one-off migrate container when it runs next to an already running app (redeploy). Containers that are already running
# are already inside MemAvailable, so only the ones that still have to start count. MEM_RESERVE_MB stays free for the
# other production services on the host. Builds are not part of deploy.sh (build-on-server.sh has its own build gate).
MEM_RESERVE_MB="${MEM_RESERVE_MB:-256}"
MEM_SERVICES="postgres redis srh srh-tls app"

mem_limit_mb() {  # mem_limit_mb <compose file> <service> → limit in MiB (fails if the service has no mem_limit)
  awk -v svc="$2" '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { cur = $1; sub(/:$/, "", cur); next }
    /^[^ #]/ { cur = "" }
    cur == svc && $1 == "mem_limit:" {
      v = tolower($2); n = v + 0
      if (v ~ /g$/) n *= 1024; else if (v ~ /k$/) n = int(n / 1024); else if (v ~ /^[0-9]+$/) n = int(n / 1048576)
      print n; found = 1; exit
    }
    END { if (!found) exit 1 }' "$1"
}
mem_avail_mb() { awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; }
svc_running() { [ "$(docker inspect -f '{{.State.Running}}' "nbshiyan-$1-1" 2>/dev/null)" = true ]; }

mem_need_mb() {  # mem_need_mb <compose file> → MiB the deploy may still add (+ reserve); prints the number
  local f="$1" s n need=0 app_up=0
  for s in $MEM_SERVICES; do
    n=$(mem_limit_mb "$f" "$s") || { echo "mem_limit missing for $s" >&2; return 1; }
    if svc_running "$s"; then [ "$s" = app ] && app_up=1; else need=$((need + n)); fi
  done
  if (( app_up )); then n=$(mem_limit_mb "$f" migrate) || return 1; need=$((need + n)); fi
  echo $((need + MEM_RESERVE_MB))
}

mem_ok() {  # mem_ok <compose file> → PASS/FAIL line, 0 = enough MemAvailable for the services that still start
  local need avail
  need=$(mem_need_mb "$1") || { log "FAIL memory check: cannot read mem_limit from compose"; return 1; }
  avail=$(mem_avail_mb); [[ "$avail" =~ ^[0-9]+$ ]] || { log "FAIL memory check: MemAvailable unreadable"; return 1; }
  if (( avail >= need )); then log "PASS memory: MemAvailable ${avail} MiB >= need ${need} MiB (limits of services still to start + reserve ${MEM_RESERVE_MB})"
  else log "FAIL memory: MemAvailable ${avail} MiB < need ${need} MiB (limits of services still to start + reserve ${MEM_RESERVE_MB})"; return 1; fi
}
