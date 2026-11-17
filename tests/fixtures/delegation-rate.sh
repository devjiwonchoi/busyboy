#!/bin/sh
# Vendored from devjiwonchoi/skills@f179d4d3c37a9b60393723872fff0e5b2c0d0c12
# skills/utils/retro/delegation-rate. The remember journey runs this copy.
# Print the delegation rate for one local-time ISO week.
#
# Usage: delegation-rate [--week YYYY-Www] FILE_OR_DIR...
# The default week is the current ISO week in local time. A directory
# contributes files named RETRO.md. Symlinked roots are followed.
# Each file is counted once, by its physical path. A quoted date is
# accepted. realpath is used when it exists, otherwise cd -P and pwd -P.
#
# Front matter requires date (YYYY-MM-DD), interventions_after_approval,
# end_state_items_total, end_state_items_met, review_change_requests,
# and delegated. Other keys are allowed. Counts use no leading zeros.
# end_state_items_total must be at least 1, and end_state_items_met must
# not exceed it. delegated is true only when interventions_after_approval
# is 0 and end_state_items_met equals end_state_items_total.
# A file counts when its date falls on Monday through Sunday of the week.
# A directory file outside that week is ignored. A file named on the
# command line is checked even when its date is outside the week, and
# it is not counted. delegation_rate is delegated/tasks, unreduced.
# No counted files prints 0/0.

set -eu
LC_ALL=C
export LC_ALL

usage() {
  printf 'usage: delegation-rate [--week YYYY-Www] FILE_OR_DIR...\n' >&2
  exit 2
}

week=
while [ "$#" -gt 0 ]; do
  case $1 in
    --week)
      [ "$#" -ge 2 ] || usage
      week=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      usage
      ;;
    *)
      break
      ;;
  esac
done

[ "$#" -ge 1 ] || usage

if [ -n "$week" ]; then
  case $week in
    [0-9][0-9][0-9][0-9]-W[0-9][0-9]) ;;
    *) usage ;;
  esac
  case $week in
    ????-W0[1-9]|????-W[1-4][0-9]|????-W5[0-3]) ;;
    *) usage ;;
  esac
fi

today=$(date +%Y-%m-%d) || exit 1

resolve_path() {
  f=$1
  if command -v realpath >/dev/null 2>&1; then
    realpath "$f"
    return
  fi
  case $f in
    /*) ;;
    *)
      here=$(CDPATH= cd -P -- . && pwd -P) || return 1
      f=$here/$f
      ;;
  esac
  n=0
  while [ -L "$f" ]; do
    n=$((n + 1))
    [ "$n" -le 40 ] || return 1
    line=$(ls -ld "$f") || return 1
    target=${line#* -> }
    [ "$target" != "$line" ] || return 1
    case $target in
      /*) f=$target ;;
      *) f=$(dirname "$f")/$target ;;
    esac
  done
  dir=$(dirname "$f")
  base=$(basename "$f")
  phys=$(CDPATH= cd -P -- "$dir" && pwd -P) || return 1
  case $phys in
    /) printf '/%s\n' "$base" ;;
    *) printf '%s/%s\n' "$phys" "$base" ;;
  esac
}

raw=$(mktemp) || exit 1
canon=$(mktemp) || {
  rm -f "$raw"
  exit 1
}
explicit=$(mktemp) || {
  rm -f "$raw" "$canon"
  exit 1
}
found=$(mktemp) || {
  rm -f "$raw" "$canon" "$explicit"
  exit 1
}
trap 'rm -f "$raw" "$canon" "$explicit" "$found"' EXIT HUP INT TERM
tab=$(printf '\t')

for arg do
  if [ -d "$arg" ]; then
    if ! find -H "$arg" -name RETRO.md -type f >"$found"; then
      printf 'delegation-rate: cannot read %s\n' "$arg" >&2
      exit 1
    fi
    while IFS= read -r file; do
      printf '0\t%s\n' "$file"
    done <"$found" >>"$raw"
  elif [ -f "$arg" ]; then
    printf '1\t%s\n' "$arg" >>"$raw"
  else
    printf 'delegation-rate: not found: %s\n' "$arg" >&2
    exit 1
  fi
done

if [ -s "$raw" ]; then
  while IFS= read -r entry; do
    mark=${entry%%"$tab"*}
    file=${entry#*"$tab"}
    if ! resolved=$(resolve_path "$file"); then
      printf 'delegation-rate: cannot resolve %s\n' "$file" >&2
      exit 1
    fi
    if [ ! -s "$resolved" ]; then
      printf 'delegation-rate: %s: missing front matter\n' "$resolved" >&2
      exit 1
    fi
    printf '%s\n' "$resolved" >>"$canon"
    if [ "$mark" -eq 1 ]; then
      printf '%s\n' "$resolved" >>"$explicit"
    fi
  done <"$raw"
  LC_ALL=C sort -u "$canon" -o "$canon"
  if [ -s "$explicit" ]; then
    LC_ALL=C sort -u "$explicit" -o "$explicit"
  fi
fi

set --
if [ -s "$canon" ]; then
  while IFS= read -r file; do
    set -- "$@" "$file"
  done <"$canon"
fi

awk -v today="$today" -v reqweek="$week" -v explicit_file="$explicit" '
function reject(msg) {
  printf "delegation-rate: %s: %s\n", prev, msg > "/dev/stderr"
  bad = 1
  state = "bad"
}

function days_from_civil(y, m, d,    era, yoe, doy, doe) {
  if (m <= 2) y--
  if (y >= 0) era = int(y / 400)
  else era = int((y - 399) / 400)
  yoe = y - era * 400
  doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civil_from_days(z,    era, doe, yoe, y, doy, mp, d, m) {
  z += 719468
  if (z >= 0) era = int(z / 146097)
  else era = int((z - 146096) / 146097)
  doe = z - era * 146097
  yoe = int((doe - int(doe / 1460) + int(doe / 36524) - int(doe / 146096)) / 365)
  y = yoe + era * 400
  doy = doe - (365 * yoe + int(yoe / 4) - int(yoe / 100))
  mp = int((5 * doy + 2) / 153)
  d = doy - int((153 * mp + 2) / 5) + 1
  if (mp < 10) m = mp + 3
  else m = mp - 9
  if (m <= 2) y++
  cy = y
  cm = m
  cd = d
}

function iso_dow(days,    dow) {
  dow = (days + 3) % 7
  if (dow < 0) dow += 7
  return dow + 1
}

function ymd_string(y, m, d) {
  return sprintf("%04d-%02d-%02d", y, m, d)
}

function iso_week_of_ymd(y, m, d,    days, dow, thu, doy) {
  days = days_from_civil(y, m, d)
  dow = iso_dow(days)
  thu = days + (4 - dow)
  civil_from_days(thu)
  iy = cy
  doy = thu - days_from_civil(cy, 1, 1) + 1
  iw = int((doy - 1) / 7) + 1
}

function week_id(y, w) {
  return sprintf("%04d-W%02d", y, w)
}

function monday_of(year, wk,    jan4, dow) {
  jan4 = days_from_civil(year, 1, 4)
  dow = iso_dow(jan4)
  return jan4 - (dow - 1) + (wk - 1) * 7
}

function unquote(s,    n, a, b, dq, sq) {
  n = length(s)
  if (n < 2) return s
  a = substr(s, 1, 1)
  b = substr(s, n, 1)
  dq = sprintf("%c", 34)
  sq = sprintf("%c", 39)
  if ((a == dq && b == dq) || (a == sq && b == sq))
    return substr(s, 2, n - 2)
  return s
}

function parse_ymd(s,    y, m, d, days) {
  if (s !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) return 0
  y = substr(s, 1, 4) + 0
  m = substr(s, 6, 2) + 0
  d = substr(s, 9, 2) + 0
  if (m < 1 || m > 12 || d < 1) return 0
  days = days_from_civil(y, m, d)
  civil_from_days(days)
  py = cy
  pm = cm
  pd = cd
  return (cy == y && cm == m && cd == d)
}

function setup_week(    y, w, monday, sunday) {
  if (reqweek == "") {
    if (!parse_ymd(today)) {
      printf "delegation-rate: cannot read the local date\n" > "/dev/stderr"
      return 0
    }
    iso_week_of_ymd(py, pm, pd)
    y = iy
    w = iw
  } else {
    y = substr(reqweek, 1, 4) + 0
    w = substr(reqweek, 7, 2) + 0
  }
  monday = monday_of(y, w)
  civil_from_days(monday)
  my = cy
  mm = cm
  md = cd
  iso_week_of_ymd(my, mm, md)
  if (iy != y || iw != w) {
    printf "delegation-rate: invalid week %s\n", week_id(y, w) > "/dev/stderr"
    return 0
  }
  week_name = week_id(y, w)
  week_start = ymd_string(my, mm, md)
  sunday = monday + 6
  civil_from_days(sunday)
  week_end = ymd_string(cy, cm, cd)
  return 1
}

function is_sep(s) {
  sub(/\r$/, "", s)
  return s ~ /^---[ \t]*$/
}

function is_uint(s) {
  return s ~ /^(0|[1-9][0-9]*)$/
}

function parse_line(line,    key, value) {
  sub(/\r$/, "", line)
  if (line ~ /^[ \t]*$/) return
  sub(/^[ \t]+/, "", line)
  sub(/[ \t]+$/, "", line)
  if (line !~ /^[A-Za-z][A-Za-z0-9_-]*:[ \t]*/ && line !~ /^[A-Za-z][A-Za-z0-9_-]*:$/) {
    reject("bad front matter line")
    return
  }
  key = line
  sub(/:.*/, "", key)
  value = line
  sub(/^[^:]+:[ \t]*/, "", value)
  sub(/[ \t]+$/, "", value)
  if (seen[key] == 1) {
    reject("duplicate field " key)
    return
  }
  if (key == "date") {
    value = unquote(value)
    if (!parse_ymd(value)) {
      reject("date must be YYYY-MM-DD")
      return
    }
  }
  seen[key] = 1
  val[key] = value
}

function accept(    keys, n, i, k, missing, expected, reasons, total, met, interventions, outside) {
  if (seen["date"] != 1) {
    reject("missing date")
    return
  }
  outside = (val["date"] < week_start || val["date"] > week_end)
  if (outside && explicit[prev] != 1) {
    state = "done"
    return
  }
  missing = ""
  keys = "interventions_after_approval end_state_items_total end_state_items_met review_change_requests delegated"
  n = split(keys, keys_arr, " ")
  for (i = 1; i <= n; i++) {
    k = keys_arr[i]
    if (seen[k] != 1) {
      if (missing != "") missing = missing " "
      missing = missing k
    }
  }
  if (missing != "") {
    reject("missing " missing)
    return
  }
  if (!is_uint(val["interventions_after_approval"]) || !is_uint(val["end_state_items_total"]) || !is_uint(val["end_state_items_met"]) || !is_uint(val["review_change_requests"])) {
    if (!is_uint(val["interventions_after_approval"])) reject("interventions_after_approval must be an integer without leading zeros")
    else if (!is_uint(val["end_state_items_total"])) reject("end_state_items_total must be an integer without leading zeros")
    else if (!is_uint(val["end_state_items_met"])) reject("end_state_items_met must be an integer without leading zeros")
    else reject("review_change_requests must be an integer without leading zeros")
    return
  }
  if (val["delegated"] != "true" && val["delegated"] != "false") {
    reject("delegated must be true or false")
    return
  }
  total = val["end_state_items_total"] + 0
  met = val["end_state_items_met"] + 0
  interventions = val["interventions_after_approval"] + 0
  if (total < 1) {
    reject("end_state_items_total must be at least 1")
    return
  }
  if (met > total) {
    reject("end_state_items_met is greater than end_state_items_total")
    return
  }
  if (interventions == 0 && met == total) expected = "true"
  else expected = "false"
  if (val["delegated"] != expected) {
    reject("delegated is " val["delegated"] ", want " expected)
    return
  }
  if (outside) {
    state = "done"
    return
  }
  tasks++
  if (expected == "true") {
    delegated_n++
    state = "done"
    return
  }
  reasons = ""
  if (interventions > 0) reasons = "interventions_after_approval"
  if (met != total) {
    if (reasons != "") reasons = reasons " "
    reasons = reasons "end_state_incomplete"
  }
  nd++
  nd_path[nd] = prev
  nd_reason[nd] = reasons
  state = "done"
}

function close_prev() {
  if (state == "front") reject("unclosed front matter")
}

function emit(    i) {
  printf "week: %s\n", week_name
  printf "week_start: %s\n", week_start
  printf "week_end: %s\n", week_end
  printf "tasks: %d\n", tasks
  printf "delegated: %d\n", delegated_n
  printf "not_delegated: %d\n", tasks - delegated_n
  printf "delegation_rate: %d/%d\n", delegated_n, tasks
  printf "not_delegated_tasks:\n"
  for (i = 1; i <= nd; i++) {
    printf "- path: %s\n", nd_path[i]
    printf "  reasons: %s\n", nd_reason[i]
  }
}

BEGIN {
  bom = sprintf("%c%c%c", 239, 187, 191)
  tasks = 0
  delegated_n = 0
  nd = 0
  bad = 0
  started = 0
  week_ok = setup_week()
  if (!week_ok) exit 1
  while ((getline explicit_line < explicit_file) > 0)
    explicit[explicit_line] = 1
  close(explicit_file)
}

{
  if (FNR == 1) {
    if (started) close_prev()
    started = 1
    delete seen
    delete val
    state = "start"
    prev = FILENAME
    if (index($0, bom) == 1)
      $0 = substr($0, length(bom) + 1)
  }
  if (state == "done" || state == "bad") next
  if (state == "start") {
    if (!is_sep($0)) {
      reject("missing front matter")
      next
    }
    state = "front"
    next
  }
  if (is_sep($0)) {
    accept()
    next
  }
  parse_line($0)
}

END {
  if (started) close_prev()
  if (!week_ok || bad) exit 1
  emit()
}
' "$@"
