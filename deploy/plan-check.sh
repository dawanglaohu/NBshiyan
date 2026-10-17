#!/usr/bin/env bash
# Destructive-change gate for the `prisma migrate diff --script` plan. Sourced by deploy.sh and deploy/tests/plan-check.test.sh.
# plan_problems <plan.sql>  → prints one line per problem (no output = additive only). Case-insensitive. Fail closed:
# anything it cannot classify is reported, never silently allowed.
#
# Parsing (statement-based, not line-based):
#   1. per line: string literals → '' and `-- comments` removed
#   2. whole file joined into one line, then split into statements on ';'
#   3. for keyword checks, quoted identifiers are replaced by "" (so "isDefault", "dropAt", "Rename" never match)
#   4. ALTER TABLE on an EXISTING table (= not CREATE TABLE'd in the same plan): parentheses collapsed, then split into
#      clauses on ',' and each clause checked on its own
# Always blocked: DROP, RENAME, TRUNCATE, DELETE FROM, ALTER … TYPE, SET NOT NULL, unrecognised statements.
# Blocked on existing tables only: CREATE UNIQUE INDEX, ADD CONSTRAINT / PRIMARY KEY / UNIQUE / REFERENCES / CHECK,
#   and any clause with NOT NULL but no DEFAULT.

_pc_unq() { local n="$1"; n="${n#\"}"; n="${n%\"}"; printf '%s' "$n"; }
_pc_isnew() { grep -qxF -- "$2" <<<"$1"; }   # exact, case-sensitive (quoted identifiers are case-sensitive)
_pc_kw() { [[ "$1" =~ (^|[^A-Za-z0-9_])($2)([^A-Za-z0-9_]|$) ]]; }   # word-boundary keyword match (nocasematch on)

plan_problems() {
  local plan="$1" s x t body clause new_tables=$'\n' restore
  local ID='("[^"]+"|[A-Za-z0-9_]+)' SP='[[:space:]]+'
  local QN="(${ID}\\.)?${ID}"
  restore=$(shopt -p nocasematch); shopt -s nocasematch
  local stmts
  stmts=$(sed -E "s/'([^']|'')*'/''/g; s/--.*$//" "$plan" | tr '\n\r\t' '   ' | sed 's/;/;\n/g')
  # pass 1: tables created by this plan
  while IFS= read -r s; do
    s="${s#"${s%%[![:space:]]*}"}"
    if [[ "$s" =~ ^CREATE${SP}TABLE${SP}(IF${SP}NOT${SP}EXISTS${SP})?${QN} ]]; then
      new_tables+="$(_pc_unq "${BASH_REMATCH[-1]}")"$'\n'
    fi
  done <<<"$stmts"
  # pass 2: classify every statement
  while IFS= read -r s; do
    s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
    [ -z "$s" ] || [ "$s" = ";" ] && continue
    # shellcheck disable=SC2001  # needs a regex ([^"]*), not a glob
    x=$(sed 's/"[^"]*"/""/g' <<<"$s")
    _pc_kw "$x" 'DROP'                && echo "DROP: ${s:0:80}"
    _pc_kw "$x" 'RENAME'              && echo "RENAME: ${s:0:80}"
    _pc_kw "$x" 'TRUNCATE'            && echo "TRUNCATE: ${s:0:80}"
    _pc_kw "$x" "DELETE${SP}FROM"     && echo "DELETE FROM: ${s:0:80}"
    _pc_kw "$x" "SET${SP}NOT${SP}NULL" && echo "SET NOT NULL: ${s:0:80}"
    if [[ "$s" =~ ^CREATE${SP}TABLE${SP} ]]; then :
    elif [[ "$s" =~ ^CREATE${SP}UNIQUE${SP}INDEX${SP}.*${SP}ON${SP}(ONLY${SP})?${QN} ]]; then
      t=$(_pc_unq "${BASH_REMATCH[-1]}")
      _pc_isnew "$new_tables" "$t" || echo "CREATE UNIQUE INDEX on existing table $t"
    elif [[ "$s" =~ ^CREATE${SP}INDEX${SP} ]]; then :
    elif [[ "$s" =~ ^CREATE${SP}(TYPE|EXTENSION|SCHEMA|SEQUENCE)${SP} ]]; then :
    elif [[ "$x" =~ ^ALTER${SP}TYPE${SP}(\"\"\.)?\"\"${SP}ADD${SP}VALUE${SP} ]]; then :
    elif [[ "$s" =~ ^ALTER${SP}TABLE${SP}(IF${SP}EXISTS${SP})?(ONLY${SP})?${QN}(.*)$ ]]; then
      t=$(_pc_unq "${BASH_REMATCH[-2]}"); body="${BASH_REMATCH[-1]}"
      body=$(sed -E 's/"[^"]*"/""/g; :a; s/\([^()]*\)/<>/g; ta; s/;$//' <<<"$body")
      _pc_kw "$body" 'TYPE' && echo "ALTER … TYPE on $t"
      if ! _pc_isnew "$new_tables" "$t"; then
        while IFS= read -r clause; do
          if _pc_kw "$clause" 'CONSTRAINT|PRIMARY|UNIQUE|REFERENCES|CHECK|EXCLUDE'; then
            echo "ALTER TABLE $t (existing): ADD CONSTRAINT / key / check"
          elif _pc_kw "$clause" "NOT${SP}NULL" && ! _pc_kw "$clause" 'DEFAULT'; then
            echo "ALTER TABLE $t (existing): NOT NULL without DEFAULT"
          fi
        done < <(tr ',' '\n' <<<"$body")
      fi
    else
      echo "unrecognised statement (manual review): ${s:0:80}"
    fi
  done <<<"$stmts"
  eval "$restore"
}
