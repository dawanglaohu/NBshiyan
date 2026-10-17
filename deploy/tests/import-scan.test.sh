#!/usr/bin/env bash
# Tests for deploy/import-and-scan.sh with a fake docker (run: bash deploy/tests/import-scan.test.sh). Needs git, zstd, tar.
# Builds a real docker-save style tar (index.json, manifest.json, repositories, blobs) per scenario, runs the import and
# checks: exit code, the FAIL reason, :candidate + .candidate-sha only on PASS, tarball always removed, loaded tags removed
# on FAIL, and no secret value in the output.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); SCRIPT="$here/../import-and-scan.sh"; pass=0; fail=0
command -v zstd >/dev/null || { echo "import-scan: zstd missing"; exit 1; }
KEY=0x4AAAAAAATestSiteKey0123   # fake site key (format only)
mkrepo() {  # one-commit git repo on main + clone at $1/src → prints the sha
  local r="$1/origin"; mkdir -p "$r"; ( umask 022; cd "$r" && git init -q -b main && echo x > f && git add f &&
    git -c user.email=t@t -c user.name=t commit -qm init && git clone -q "$r" "$1/src" ) && git -C "$1/src" rev-parse HEAD
}
mkimage_fs() {  # mkimage_fs <FD> <scen>
  local FD="$1" s="$2" N="$1/fs/nbshiyan-app/app/.next-dist"
  mkdir -p "$N/static/chunks" "$N/server/app" "$N/server/chunks" "$FD/fs/nbshiyan-migrate/opt/migrate/prisma"
  echo 'model X { id Int @id }' > "$FD/fs/nbshiyan-migrate/opt/migrate/prisma/schema.prisma"
  printf '{"headers":[{"source":"/s/:path*","headers":[{"key":"X-Robots-Tag","value":"noindex, nofollow"}]}]}' > "$N/routes-manifest.json"
  [[ ",$s," == *,noindex,* ]] && printf '{"headers":[{"source":"/:path*","headers":[{"key":"X-Robots-Tag","value":"noindex, nofollow"}]}]}' > "$N/routes-manifest.json"
  printf 'var k="%s";if("localhost"===u.hostname){}' "$KEY" > "$N/static/chunks/main.js"
  [[ ",$s," == *,two_keys,* ]] && printf 'var k2="0x4AAAAAAAOtherSiteKey99";' > "$N/static/chunks/other.js"
  [[ ",$s," == *,sitekey_mismatch,* ]] && printf 'var k="0x4AAAAAAAOtherSiteKey99";' > "$N/static/chunks/main.js"
  [[ ",$s," == *,testkey,* ]] && printf 'var t="1x00000000000000000000AA";' > "$N/static/chunks/t.js"
  printf '<link rel="canonical" href="https://geiom.com/en">' > "$N/server/app/en.html"
  [[ ",$s," == *,no_geiom,* ]] && printf '<link rel="canonical" href="https://example.com/en">' > "$N/server/app/en.html"
  [[ ",$s," == *,localhost,* ]] && printf '<a href="http://localhost:3000/en">' > "$N/server/app/ru.html"
  # shellcheck disable=SC2016  # literal framework code sample
  printf 'return new URL(`http://localhost:${p}`)' > "$N/server/chunks/next.js"   # framework code: must NOT fail
  [[ ",$s," == *,keyfile,* ]] && echo 'dummy' > "$FD/fs/nbshiyan-app/app/.env.production"
  [[ ",$s," == *,planted,* ]] && cat "$FD/planted" > "$N/static/chunks/leak.js"
  return 0
}
mktar() {  # mktar <dir> <sha> <scen> → writes tar.zst, .sha256, .manifest into <dir>/in
  local sha="$2" s="$3" short="${2:0:12}" t="$1/tarsrc" in="$1/in" ca cm ma mm a m extra=""
  mkdir -p "$t/blobs/sha256" "$in"
  blob() { local h; h=$(printf '%s' "$1" | sha256sum | cut -c1-64); printf '%s' "$1" > "$t/blobs/sha256/$h"; echo "$h"; }
  ca=$(blob "{\"config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$sha\",\"com.nbshiyan.stack\":\"nbshiyan\"}},\"c\":\"app\"}")
  cm=$(blob "{\"config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$sha\",\"com.nbshiyan.stack\":\"nbshiyan\"}},\"c\":\"mig\"}")
  ma=$(blob "{\"schemaVersion\":2,\"config\":{\"digest\":\"sha256:$ca\"},\"m\":\"app\"}")
  mm=$(blob "{\"schemaVersion\":2,\"config\":{\"digest\":\"sha256:$cm\"},\"m\":\"mig\"}")
  a="nbshiyan-app:$short"; m="nbshiyan-migrate:$short"
  [[ ",$s," == *,foreign_tag,* ]] && extra=',"alpine:latest"'
  printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:%s","size":1,"annotations":{"io.containerd.image.name":"docker.io/library/%s","org.opencontainers.image.ref.name":"%s"}},{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:%s","size":1,"annotations":{"io.containerd.image.name":"docker.io/library/%s","org.opencontainers.image.ref.name":"%s"}}]}' \
    "$mm" "$m" "$short" "$ma" "$a" "$short" > "$t/index.json"
  printf '[{"Config":"blobs/sha256/%s","RepoTags":["%s"%s],"Layers":[]},{"Config":"blobs/sha256/%s","RepoTags":["%s"],"Layers":[]}]' "$cm" "$m" "$extra" "$ca" "$a" > "$t/manifest.json"
  printf '{"nbshiyan-app":{"%s":"x"},"nbshiyan-migrate":{"%s":"x"}}' "$short" "$short" > "$t/repositories"
  echo '{"imageLayoutVersion":"1.0.0"}' > "$t/oci-layout"
  local base="nbshiyan-images-$short"
  ( cd "$t" && tar -c index.json manifest.json repositories oci-layout blobs ) | zstd -q -o "$in/$base.tar.zst"
  ( cd "$in" && sha256sum "$base.tar.zst" > "$base.tar.zst.sha256" )
  [[ ",$s," == *,wrong_sha,* ]] && printf 'X' >> "$in/$base.tar.zst"
  local cfg_a="sha256:$ca"; [[ ",$s," == *,manifest_wrong_id,* ]] && cfg_a="sha256:$(printf y | sha256sum | cut -c1-64)"
  printf 'PIN_SHA=%s\nPLATFORM=linux/amd64\nTARBALL=%s.tar.zst\nTARBALL_SHA256=%s\nTAR_BYTES=%s\nAPP_TAG=%s\nAPP_CONFIG_ID=%s\nAPP_MANIFEST_DIGEST=sha256:%s\nMIGRATE_TAG=%s\nMIGRATE_CONFIG_ID=sha256:%s\nMIGRATE_MANIFEST_DIGEST=sha256:%s\n' \
    "$sha" "$base" "$(cut -c1-64 "$in/$base.tar.zst.sha256")" 10240 "$a" "$cfg_a" "$ma" "$m" "$cm" "$mm" > "$in/$base.manifest"
}
scen() {  # scen <name> <SCEN> <want exit> <regex that must match>
  local name="$1" s="$2" want="$3" re="$4" T sha out rc okk=1 short
  T=$(mktemp -d); sha=$(mkrepo "$T"); short=${sha:0:12}
  export FD="$T/fd"; mkdir -p "$FD/images" "$FD/dockerroot" "$T/secrets"; chmod 700 "$T/secrets"
  local sec; sec=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40)
  printf 'AUTH_SECRET=%s\nSMTP_PASS=%s\nAPP_ENV=production\n' "$sec" "$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')" > "$T/.env"; chmod 600 "$T/.env"
  printf '%s' "$sec" > "$FD/planted"
  printf 'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\n' "$KEY" > "$T/build-args.env"; chmod 600 "$T/build-args.env"
  [[ ",$s," == *,old_candidate,* ]] && { mkdir -p "$FD/images/nbshiyan-app:candidate"; echo sha256:old > "$FD/images/nbshiyan-app:candidate/id"; }
  mkimage_fs "$FD" "$s"; mktar "$T" "$sha" "$s"
  local pin="$sha"; [[ ",$s," == *,pin_mismatch,* ]] && pin=$(printf z | sha1sum | cut -c1-40)
  out=$(SCEN="$s" PATH="$here/fake-import:$PATH" NBSHIYAN_DATA_DIR="$T" PIN_SHA="$pin" IMPORT_DIR="$T/in" bash "$SCRIPT" 2>&1); rc=$?
  [ "$rc" = "$want" ] || okk=0
  grep -qE "$re" <<<"$out" || okk=0
  grep -q 'fake docker: unhandled' <<<"$out" && okk=0
  grep -qF -- "$sec" <<<"$out" && { okk=0; echo "  !! secret value in output"; }
  # (pin_mismatch: the files carry another sha12, so they are not this run's files and are left alone)
  [[ ",$s," == *,pin_mismatch,* ]] || [ -z "$(ls -A "$T/in")" ] || { okk=0; echo "  !! transferred files not removed"; }
  if [ "$want" = 0 ]; then
    [ "$(cat "$T/.candidate-sha" 2>/dev/null)" = "$sha" ] && [ -d "$FD/images/nbshiyan-app:candidate" ] && [ -d "$FD/images/nbshiyan-migrate:candidate" ] || { okk=0; echo "  !! candidate not tagged"; }
  else
    [ ! -f "$T/.candidate-sha" ] || { okk=0; echo "  !! .candidate-sha written on FAIL"; }
    [ ! -d "$FD/images/nbshiyan-migrate:candidate" ] || { okk=0; echo "  !! :candidate tagged on FAIL"; }
    [ ! -d "$FD/images/nbshiyan-app:$short" ] || { okk=0; echo "  !! loaded tag left behind on FAIL"; }
  fi
  if (( okk )); then pass=$((pass+1)); echo "PASS $name (exit $rc)"; else fail=$((fail+1)); echo "FAIL $name (exit $rc, want $want)"; printf '    | %s\n' "${out//$'\n'/$'\n'    | }"; fi
  rm -rf "$T"
}
scen good               ""                0 'done: .* tagged :candidate'
scen good_containerd    containerd        0 'PASS image IDs = manifest'
scen wrong_sha          wrong_sha         1 'FAIL: sha256sum -c failed'
scen wrong_id_after_load wrong_id         1 'FAIL: image ID of nbshiyan-app:[0-9a-f]{12} != manifest'
scen wrong_id_manifest  manifest_wrong_id 1 'FAIL: config digest of nbshiyan-app:[0-9a-f]{12} in the tar != expected'
scen wrong_revision     wrong_rev         1 'FAIL: nbshiyan-app:[0-9a-f]{12} revision label'
scen pin_mismatch       pin_mismatch      1 'FAIL: .* is not checked out at'
scen foreign_tag        foreign_tag       1 'FAIL: manifest.json RepoTags are not exactly'
scen load_foreign       load_foreign      1 'FAIL: docker load reported other images'
scen planted_secret     planted           1 'fs scan nbshiyan-app:[0-9a-f]{12}: [0-9]+ secret values, hits=1'
scen env_file_in_image  keyfile           1 'env/key files=1'
scen env_key            env_key           1 'FAIL nbshiyan-app:[0-9a-f]{12} has unexpected ENV keys: AUTH_SECRET'
scen history_secret     hist_secret       1 'FAIL secret-like assignment in docker history'
scen no_geiom           no_geiom          1 'FAIL build output lacks https://geiom.com'
scen app_env_not_prod   noindex           1 'FAIL site-wide noindex rule'
scen localhost_url      localhost         1 'FAIL localhost/loopback URL in 1 served/baked files'
scen turnstile_testkey  testkey           1 'FAIL Turnstile test key in 1 files'
scen sitekey_mismatch   sitekey_mismatch  1 'FAIL baked Turnstile site key: 1 candidate\(s\), sha256 match=no'
scen two_sitekeys       two_keys          1 'FAIL baked Turnstile site key: 2 candidate'
echo "import-scan: $pass passed, $fail failed"; [ "$fail" = 0 ]
