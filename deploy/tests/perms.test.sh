#!/usr/bin/env bash
# Checkout permissions (build-on-server.sh step 2). Run: bash deploy/tests/perms.test.sh   (no root, no network, no docker)
# Runs the REAL checkout block and perms gate, extracted from build-on-server.sh between the `# >>>` / `# <<<` markers,
# under the script's real options (set -Eeuo pipefail, global umask 077) against a local throw-away git repo.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); B="$here/../build-on-server.sh"; pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $*"; }
blk() { awk -v s="# >>> $1" -v e="# <<< $1" 'index($0,s)==1{f=1;next} index($0,e)==1{f=0} f' "$B"; }
CHECKOUT=$(blk checkout); GATE=$(blk 'perms gate')
if [ -n "$CHECKOUT" ] && [ -n "$GATE" ]; then ok; else bad "markers not found in build-on-server.sh"; fi
if grep -q 'umask 022' <<<"$CHECKOUT"; then ok; else bad "checkout block does not use umask 022"; fi
# global umask stays 077 (the subshell is the only place with 022)
if [ "$(grep -cE '^umask 077' "$B")" = 1 ]; then ok; else bad "global umask 077 missing/duplicated"; fi
if grep -qE '^\( umask 022$' <<<"$CHECKOUT"; then ok; else bad "umask 022 is not confined to a ( … ) subshell"; fi

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# throw-away origin: the kinds of files the containers read (schema, nginx.conf, public assets, an executable script)
( umask 022; mkdir -p "$T/up" && cd "$T/up" && git init -q -b main && mkdir -p prisma deploy/srh-tls public/images/posters public/models scripts \
  && echo 'datasource db {}' > prisma/schema.prisma && echo 'events {}' > deploy/srh-tls/nginx.conf \
  && printf 'RIFF' > public/images/posters/p.webp && printf 'glTF' > public/models/m.glb \
  && printf '#!/bin/sh\n' > scripts/x.sh && chmod 755 scripts/x.sh \
  && git add -A && git -c user.name=t -c user.email=t@t commit -qm init )
PIN=$(git -C "$T/up" rev-parse HEAD)
run() {  # run <src dir> → runs checkout block + gate under the real options; prints output, returns exit code
  bash -c '
    set -Eeuo pipefail; umask 077
    log() { printf "[build] %s\n" "$*"; }; die() { printf "[build] ABORT: %s\n" "$*" >&2; exit 1; }
    SRC=$1; REPO_URL=$2; PIN_SHA=$3; SHORT=${PIN_SHA:0:12}; NBSHIYAN_DATA_DIR=$(dirname "$SRC")
    case "$NBSHIYAN_DATA_DIR/secrets/" in "$SRC"/*) die "secrets dir inside src" ;; esac
    eval "$4"
    echo "UMASK_AFTER=$(umask)"
    eval "$5"
    echo GATE_OK' _ "$1" "file://$T/up" "$PIN" "$CHECKOUT" "$GATE" 2>&1
}
modes() { (cd "$1" && find . -mindepth 1 -path ./.git -prune -o ! -type l -printf '%m %p\n' | sort); }

# 1. fresh clone under the global umask 077 → 644 files, 755 dirs/exec, gate passes, global umask still 077
out=$(run "$T/d1/src"); rc=$?
mkdir -p "$T/d1" 2>/dev/null
if [ "$rc" = 0 ] && grep -q GATE_OK <<<"$out"; then ok; else bad "fresh clone: rc=$rc"; echo "$out"; fi
if grep -qx 'UMASK_AFTER=0077' <<<"$out"; then ok; else bad "global umask changed by the checkout block"; fi
m=$(modes "$T/d1/src")
if [ "$(grep -c . <<<"$m")" -gt 0 ] && ! grep -vqE '^(644|755) ' <<<"$m"; then ok; else bad "fresh clone modes not 644/755:"; echo "$m"; fi
if grep -qx '755 ./scripts/x.sh' <<<"$m" && grep -qx '644 ./prisma/schema.prisma' <<<"$m" && grep -qx '644 ./deploy/srh-tls/nginx.conf' <<<"$m"; then ok; else bad "unexpected modes: $m"; fi

# 2. an existing checkout made under umask 077 (the server today: 600 files, 700 dirs) is repaired, never past 644/755
( umask 077; mkdir -p "$T/d2" && git clone -q "file://$T/up" "$T/d2/src" )
if [ "$(stat -c %a "$T/d2/src/prisma/schema.prisma")" = 600 ]; then ok; else bad "setup: old checkout not 600"; fi
out=$(run "$T/d2/src"); rc=$?
if [ "$rc" = 0 ] && grep -q GATE_OK <<<"$out"; then ok; else bad "old 077 checkout not repaired: rc=$rc"; echo "$out"; fi
m=$(modes "$T/d2/src"); if ! grep -vqE '^(644|755) ' <<<"$m"; then ok; else bad "repaired modes not 644/755:"; echo "$m"; fi
if [ "$(stat -c %a "$T/d2/src/.git/config")" = 600 ]; then ok; else bad ".git was touched by the repair (must be excluded)"; fi

# 3. negative: the gate alone trips on a root-only tracked file, an untraversable dir, and a group/other-writable file
gate_only() { bash -c 'set -Eeuo pipefail; umask 077; die() { printf "[build] ABORT: %s\n" "$*" >&2; exit 1; }; SRC=$1; eval "$2"; echo GATE_OK' _ "$1" "$GATE" 2>&1; }
cp -a "$T/d1/src" "$T/n1"; chmod 600 "$T/n1/prisma/schema.prisma"
out=$(gate_only "$T/n1"); rc=$?
if [ "$rc" = 1 ] && grep -q 'ABORT: checkout has files non-root containers cannot read' <<<"$out" && grep -q 'prisma/schema.prisma' <<<"$out" && ! grep -q GATE_OK <<<"$out"; then ok; else bad "gate missed a root-only file: rc=$rc"; echo "$out"; fi
cp -a "$T/d1/src" "$T/n2"; chmod 700 "$T/n2/public/images"
out=$(gate_only "$T/n2"); rc=$?
if [ "$rc" = 1 ] && grep -q 'public/images' <<<"$out"; then ok; else bad "gate missed a 700 dir"; echo "$out"; fi
cp -a "$T/d1/src" "$T/n3"; chmod 666 "$T/n3/deploy/srh-tls/nginx.conf"
out=$(gate_only "$T/n3"); rc=$?
if [ "$rc" = 1 ] && grep -q 'nginx.conf' <<<"$out"; then ok; else bad "gate missed a 666 file"; echo "$out"; fi
# .git content is excluded from the gate
cp -a "$T/d1/src" "$T/n4"; chmod 600 "$T/n4/.git/HEAD"
out=$(gate_only "$T/n4"); rc=$?
if [ "$rc" = 0 ] && grep -q GATE_OK <<<"$out"; then ok; else bad "gate looked into .git"; echo "$out"; fi
# the gate has no `| grep -q` (SIGPIPE) and captures into a variable
if grep -q '| *grep -q' <<<"$GATE"; then bad "gate uses | grep -q"; else ok; fi
echo "perms: $pass passed, $fail failed"; [ "$fail" = 0 ]
