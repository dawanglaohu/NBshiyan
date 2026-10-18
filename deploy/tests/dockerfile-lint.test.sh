#!/usr/bin/env bash
# Static Dockerfile checks (run: bash deploy/tests/dockerfile-lint.test.sh). No docker needed.
# COPY/ADD with --chmod (or --chown) creates missing parent dirs of the destination, and BuildKit gives them the same mode:
# --chmod=644 → a 644 dir uid 1001 cannot enter (e155bc1: /opt/migrate/prisma). Rule: for every such COPY whose
# destination is nested (has a parent below WORKDIR / below /), the parent must be created earlier IN THE SAME STAGE by a
# `RUN mkdir -p … <parent>` (or already exist in the base image: only /usr/local/bin, /usr/bin, /etc are accepted).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); DF="${1:-$here/../../Dockerfile}"; pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $*"; }
lint() {  # lint <dockerfile> → prints one line per problem
  awk '
    function absdir(p) { if (p !~ /^\//) p = wd "/" p; gsub(/\/\.\//, "/", p); sub(/\/[^\/]*$/, "", p); return p }
    /^FROM /                     { wd = "/"; delete made; next }
    /^WORKDIR /                  { wd = $2; made[wd] = 1; next }
    /^RUN .*mkdir/               { for (i = 2; i <= NF; i++) if ($i ~ /^\//) { d = $i; while (d != "") { made[d] = 1; sub(/\/[^\/]*$/, "", d) } } next }
    /^(COPY|ADD) .*--ch(mod|own)=/ {
      dest = $NF; if ($0 ~ /<</) { for (i = 2; i <= NF; i++) if ($i ~ /^\//) dest = $i }
      if (dest ~ /\/$/) next                     # copying INTO a dir: parent = dest itself, created with the dest
      par = absdir(dest)
      if (par == "" || par == wd || (par in made) || par ~ /^\/(usr\/local\/bin|usr\/bin|etc)$/) next
      print "line " NR ": " $0 "  → parent " par " is created by COPY with the file mode (add RUN mkdir -p -m 755 " par " first)"
    }' "$1"
}
out=$(lint "$DF"); if [ -z "$out" ]; then ok; else bad "Dockerfile:"; echo "$out"; fi
# self-tests: the rule must flag the e155bc1 form and accept the fixed form / existing system dirs
T=$(mktemp); trap 'rm -f "$T"' EXIT
printf 'FROM x AS migrate\nWORKDIR /opt/migrate\nRUN npm install prisma\nCOPY --from=builder --chmod=644 /app/prisma/schema.prisma ./prisma/schema.prisma\n' > "$T"
if [ -n "$(lint "$T")" ]; then ok; else bad "lint misses the e155bc1 form (missing parent ./prisma)"; fi
printf 'FROM x AS migrate\nWORKDIR /opt/migrate\nRUN mkdir -p -m 755 /opt/migrate/prisma\nCOPY --from=builder --chmod=644 /app/prisma/schema.prisma ./prisma/schema.prisma\n' > "$T"
if [ -z "$(lint "$T")" ]; then ok; else bad "lint flags the fixed form"; lint "$T"; fi
printf 'FROM x AS a\nRUN mkdir -p /opt/a/b\nFROM y AS b\nWORKDIR /opt\nCOPY --chmod=644 x /opt/a/b/f\n' > "$T"
if [ -n "$(lint "$T")" ]; then ok; else bad "lint accepts a mkdir from another stage"; fi
printf 'FROM x\nCOPY --chmod=755 <<'"'"'SH'"'"' /usr/local/bin/tool\n#!/bin/sh\nSH\nCOPY --chmod=644 f /app.conf\n' > "$T"
if [ -z "$(lint "$T")" ]; then ok; else bad "lint flags /usr/local/bin heredoc or a top-level file"; lint "$T"; fi
# the migrate stage must still have the 644 chmod and the uid-1001 check (both stay)
if grep -qE '^COPY --from=builder --chmod=644 /app/prisma/schema.prisma \./prisma/schema\.prisma$' "$DF"; then ok; else bad "schema COPY --chmod=644 missing"; fi
if grep -qF 'find /opt/migrate \( ! -readable' "$DF"; then ok; else bad "migrate uid-1001 readability check missing"; fi
echo "dockerfile-lint: $pass passed, $fail failed"; [ "$fail" = 0 ]
