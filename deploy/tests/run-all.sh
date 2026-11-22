#!/usr/bin/env bash
# 跑 deploy/tests 下固定的 9 个脚本。集合写死在 MANIFEST，不按 glob 推断。
# 判定：缺/多/清单重复、退出码非零、汇总行缺失/重复/名字不符/passed=0/failed>0/数字超范围、
#       工作副本字节与 HEAD blob 不一致、HEAD 与 GITHUB_SHA 不同头 —— 任一即失败；九项跑完才给总分。
# 报表只含固定字段（名字/退出码/计数/blob/固定原因码），不转发任何脚本原文。
# 退出码：0 全过；1 有失败；2 基础设施失败（日志目录不可写等）。
# 用法：bash deploy/tests/run-all.sh [日志目录]
set -uo pipefail

MANIFEST='
smoke.test.sh|smoke
mem-check.test.sh|mem-check
dockerfile-lint.test.sh|dockerfile-lint
env-check.test.sh|env-check
perms.test.sh|perms
pipefail-lint.test.sh|pipefail-lint
plan-check.test.sh|plan-check
build-offbox.test.sh|build-offbox
import-scan.test.sh|import-scan
'

die() { printf 'FATAL: %s\n' "$*" >&2; exit 2; }
jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\010\013\014\016-\037'; }
is_num() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -le 6 ]; }

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
logdir=${1:-deploy-test-logs}
case "$logdir" in /*) ;; *) logdir="$repo/$logdir" ;; esac

mkdir -p "$logdir/failures" || die "cannot create log dir: $logdir"
for f in "$logdir"/failures/*.json; do
  [ -e "$f" ] || continue
  rm -f -- "$f" || die "cannot clear stale failure file: $f"
done

names=(); labels=()
while IFS='|' read -r n l; do
  [ -z "$n" ] && continue
  names+=("$n"); labels+=("$l")
done <<< "$MANIFEST"

expected=${#names[@]}
dup=""
for i in "${!names[@]}"; do
  for j in "${!names[@]}"; do
    if [ "$i" -lt "$j" ] && [ "${names[$i]}" = "${names[$j]}" ]; then dup="${dup} ${names[$j]}"; fi
  done
done

head_sha=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo n/a)
tree_sha=$(git -C "$repo" rev-parse 'HEAD^{tree}' 2>/dev/null || echo n/a)
logrel=""
case "$logdir" in "$repo"/*) logrel="${logdir#"$repo"/}" ;; esac
if [ -n "$logrel" ]; then
  dirty=$((git -C "$repo" status --porcelain -uall -- . ":(exclude)$logrel" 2>/dev/null || true) | wc -l | tr -d ' ')
else
  dirty=$((git -C "$repo" status --porcelain -uall 2>/dev/null || true) | wc -l | tr -d ' ')
fi
head_mismatch=no
if [ -n "${GITHUB_SHA:-}" ] && [ "$head_sha" != "${GITHUB_SHA}" ]; then head_mismatch=yes; fi

{
  printf 'checkout_head=%s\n' "$head_sha"
  printf 'checkout_tree=%s\n' "$tree_sha"
  printf 'checkout_dirty_lines=%s\n' "$dirty"
  printf 'checkout_github_sha=%s\n' "${GITHUB_SHA:-}"
  printf 'checkout_head_matches_github_sha=%s\n' "$([ "$head_mismatch" = yes ] && echo no || echo yes)"
  printf 'repo=%s\n' "$repo"
  printf 'bash=%s\n' "$(bash --version | head -n 1)"
  printf 'date_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$logdir/checkout.txt" || die "cannot write checkout.txt"
[ -s "$logdir/checkout.txt" ] || die "checkout.txt empty after write"

shopt -s nullglob
actual=("$here"/*.test.sh)
shopt -u nullglob

has() { local x=$1; shift; local y; for y in "$@"; do [ "$x" = "$y" ] && return 0; done; return 1; }

missing=(); for n in "${names[@]}"; do [ -f "$here/$n" ] || missing+=("$n"); done
extra=(); for f in "${actual[@]}"; do b=$(basename "$f"); has "$b" "${names[@]}" || extra+=("$b"); done

printf 'script\trc\tpass\tfail\tsummary_lines\thead_blob\tfile_blob\tverdict\treason\n' > "$logdir/summary.tsv" \
  || die "cannot write summary.tsv"
rows=""
ran=0; passed=0; failed=0
add_row() {
  if [ -n "$rows" ]; then rows="$rows,"; fi
  rows="$rows
    {\"script\":\"$(jesc "$1")\",\"rc\":\"$(jesc "$2")\",\"passed\":\"$(jesc "$3")\",\"failed\":\"$(jesc "$4")\",\"summary_lines\":\"$(jesc "$5")\",\"head_blob\":\"$(jesc "$6")\",\"file_blob\":\"$(jesc "$7")\",\"verdict\":\"$(jesc "$8")\",\"reason\":\"$(jesc "$9")\"}"
}

for i in "${!names[@]}"; do
  name=${names[$i]}; label=${labels[$i]}; t="$here/$name"
  if [ ! -f "$t" ]; then
    add_row "$name" "-" "-" "-" "0" "n/a" "-" "MISSING" "missing"
    printf '%s\t-\t-\t-\t0\tn/a\t-\tMISSING\tmissing\n' "$name" >> "$logdir/summary.tsv" || die "cannot append summary.tsv"
    printf 'MISSING %-24s\n' "$name"
    failed=$((failed+1)); continue
  fi
  headblob=$(git -C "$repo" rev-parse "HEAD:deploy/tests/$name" 2>/dev/null || true)
  fileblob=$(git -C "$repo" hash-object --no-filters -- "$t" 2>/dev/null || true)
  rc="-"; pv="-"; fv="-"; cnt=0; verdict=PASS; reason=""
  if [ -z "$headblob" ]; then
    verdict=FAIL; reason=identity-unavailable
  elif [ -z "$fileblob" ]; then
    verdict=FAIL; reason=identity-unavailable
  elif [ "$headblob" != "$fileblob" ]; then
    verdict=FAIL; reason=content-mismatch
  fi
  if [ "$verdict" = PASS ]; then
    ran=$((ran+1))
    full="$logdir/$name.log"
    start=$(date +%s)
    bash "$t" >"$full" 2>&1
    rc=$?
    dur=$(( $(date +%s) - start ))
    cnt=$(grep -cE "^${label}: [0-9]+ passed, [0-9]+ failed$" "$full" || true); cnt=${cnt:-0}
    if [ "$cnt" = 1 ]; then
      line=$(grep -E "^${label}: [0-9]+ passed, [0-9]+ failed$" "$full")
      pv=$(printf '%s\n' "$line" | sed -E "s/^${label}: ([0-9]+) passed, ([0-9]+) failed$/\1/")
      fv=$(printf '%s\n' "$line" | sed -E "s/^${label}: ([0-9]+) passed, ([0-9]+) failed$/\2/")
      if ! is_num "$pv" || ! is_num "$fv"; then verdict=FAIL; reason=summary-malformed
      fi
    fi
    if [ "$verdict" = PASS ] && [ "$rc" -ne 0 ]; then verdict=FAIL; reason=exit
    elif [ "$verdict" = PASS ] && [ "$cnt" -ne 1 ]; then verdict=FAIL; reason=summary-lines
    elif [ "$verdict" = PASS ] && [ "$fv" -ne 0 ]; then verdict=FAIL; reason=summary-failed
    elif [ "$verdict" = PASS ] && [ "$pv" -le 0 ]; then verdict=FAIL; reason=summary-passed-zero
    fi
    printf 'PASS/FAIL duration: %s\n' "$dur" >/dev/null
  fi
  add_row "$name" "$rc" "$pv" "$fv" "$cnt" "${headblob:-n/a}" "${fileblob:--}" "$verdict" "$reason"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$rc" "$pv" "$fv" "$cnt" "${headblob:-n/a}" "${fileblob:--}" "$verdict" "$reason" >> "$logdir/summary.tsv" || die "cannot append summary.tsv"
  if [ "$verdict" = PASS ]; then
    passed=$((passed+1)); printf 'PASS %-24s passed=%s failed=%s\n' "$name" "$pv" "$fv"
  else
    failed=$((failed+1)); printf 'FAIL %-24s reason=%s rc=%s lines=%s\n' "$name" "$reason" "$rc" "$cnt"
    printf '{\"script\":\"%s\",\"rc\":\"%s\",\"summary_lines\":\"%s\",\"passed\":\"%s\",\"failed\":\"%s\",\"reason\":\"%s\",\"head_blob\":\"%s\",\"file_blob\":\"%s\"}\n' \
      "$(jesc "$name")" "$(jesc "$rc")" "$(jesc "$cnt")" "$(jesc "$pv")" "$(jesc "$fv")" "$(jesc "$reason")" "$(jesc "${headblob:-n/a}")" "$(jesc "${fileblob:--}")" \
      > "$logdir/failures/$name.json" || die "cannot write failure evidence: $name"
  fi
done

miss_j=""; [ "${#missing[@]}" -gt 0 ] && miss_j=$(printf '%s ' "${missing[@]}")
extra_j=""; [ "${#extra[@]}" -gt 0 ] && extra_j=$(printf '%s ' "${extra[@]}")
result=FAIL
if [ "$failed" -eq 0 ] && [ "${#missing[@]}" -eq 0 ] && [ "${#extra[@]}" -eq 0 ] && [ -z "$dup" ] && [ "$ran" -eq "$expected" ] && [ "$head_mismatch" = no ]; then
  result=PASS
fi
{
  printf '{\n'
  printf '  "checkout": {"head": "%s", "tree": "%s", "dirty_lines": "%s", "github_sha": "%s", "head_matches_github_sha": "%s"},\n' \
    "$(jesc "$head_sha")" "$(jesc "$tree_sha")" "$(jesc "$dirty")" "$(jesc "${GITHUB_SHA:-}")" "$([ "$head_mismatch" = yes ] && echo no || echo yes)"
  printf '  "expected": %s, "ran": %s, "passed": %s, "failed": %s,\n' "$expected" "$ran" "$passed" "$failed"
  printf '  "missing": "%s", "extra": "%s", "duplicate": "%s",\n' "$(jesc "$miss_j")" "$(jesc "$extra_j")" "$(jesc "$dup")"
  printf '  "result": "%s",\n' "$result"
  printf '  "scripts": [%s\n  ]\n}\n' "$rows"
} > "$logdir/report.json" || die "cannot write report.json"
[ -s "$logdir/report.json" ] || die "report.json empty after write"

printf 'checkout: HEAD=%s tree=%s dirty=%s github_sha=%s\n' "$head_sha" "$tree_sha" "$dirty" "${GITHUB_SHA:-}"
printf 'deploy-tests: expected=%s ran=%s passed=%s failed=%s missing=%s extra=%s head_mismatch=%s\n' \
  "$expected" "$ran" "$passed" "$failed" "${#missing[@]}" "${#extra[@]}" "$head_mismatch"
if [ -n "$dup" ]; then printf 'METADATA: duplicate manifest entries:%s\n' "$dup"; fi
if [ "${#missing[@]}" -gt 0 ]; then printf 'MISSING: %s\n' "${missing[*]}"; fi
if [ "${#extra[@]}" -gt 0 ]; then printf 'EXTRA: %s\n' "${extra[*]}"; fi

if [ "$result" = PASS ]; then printf 'RESULT: PASS\n'; exit 0; fi
printf 'RESULT: FAIL\n'; exit 1
