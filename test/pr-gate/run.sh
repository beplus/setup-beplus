#!/usr/bin/env bash
# The PR gate's two scripts (pr-gate/action.yml: `stack`, `decide`), run against a fake `gh`
# and a throwaway git repository. Needs bash ≥ 4, git and yq. Rush's impact is not run here
# (it needs a Rush repository); the paths, `always` and the fail-open answers are.
#
#   test/pr-gate/run.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
action="$here/../../pr-gate/action.yml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

yq '.runs.steps[] | select(.id == "stack") | .run' "$action" > "$work/stack.sh"
yq '.runs.steps[] | select(.id == "decide") | .run' "$action" > "$work/decide.sh"
always="$(yq '.inputs.always.default' "$action")"

# A fake gh: `pulls?base=<b>` answers the PRs based on <b>, `pulls?head=<owner>:<h>` the PR
# whose head is <h>, from $work/prs (number base head repo [draft] per line; draft defaults to
# false). FAIL_GH makes it fail.
mkdir -p "$work/bin"
cat > "$work/bin/gh" << 'EOF'
#!/usr/bin/env bash
[[ -n "${FAIL_GH:-}" ]] && { echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; }
base="" head="" jq=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) case "$2" in base=*) base="${2#base=}" ;; head=*) head="${2#*:}" ;; esac; shift 2 ;;
    --jq) jq="$2"; shift 2 ;;
    *) shift ;;
  esac
done
json="["
sep=""
while read -r n b h r d; do
  [[ -z "$n" ]] && continue
  if { [[ -n "$base" && "$b" == "$base" ]] || [[ -n "$head" && "$h" == "$head" ]]; }; then
    json+="$sep{\"number\":$n,\"draft\":${d:-false},\"base\":{\"ref\":\"$b\"},\"head\":{\"ref\":\"$h\",\"repo\":{\"full_name\":\"$r\"}}}"
    sep=","
  fi
done < "$PRS"
json+="]"
printf '%s' "$json" | jq -r "$jq"
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" PRS="$work/prs"

failures=0
has() { # <case> <key> <wanted substring> <outputs file>
  local got
  got="$(sed -n "s/^$2=//p" "$4" | tail -n 1)"
  if [[ "$got" == *"$3"* ]]; then echo "✓ $1 ($2 has \"$3\")"; else echo "✗ $1: $2 is \"$got\", want it to have \"$3\""; failures=$((failures + 1)); fi
}
expect() { # <case> <key> <want> <outputs file>
  local got
  got="$(sed -n "s/^$2=//p" "$4" | tail -n 1)"
  if [[ "$got" == "$3" ]]; then echo "✓ $1 ($2=$got)"; else echo "✗ $1: $2 is \"$got\", want \"$3\""; failures=$((failures + 1)); fi
}

stack() { # <case> <draft> <head> <base> <want decided> <want run|root> [head repo]
  local out="$work/out"
  : > "$out"
  GITHUB_OUTPUT="$out" EVENT=pull_request REPO=o/r OWNER=o DRAFT="$2" NUMBER=9 HEAD_REF="$3" \
    HEAD_REPO="${7:-o/r}" BASE_REF="$4" STACK=top-only bash "$work/stack.sh" > /dev/null 2>&1
  expect "$1" decided "$5" "$out"
  if [[ "$5" == true ]]; then expect "$1" run "$6" "$out"; else expect "$1" root "$6" "$out"; fi
}

# The stack: #1 dev <- a, #2 a <- b, #3 b <- c (the top); #4 dev <- x, alone; #5 a fork's PR.
# Drafts above (bepluscloud/ai#885 merged untested under draft #886):
#   #6 dev <- p, ready, with only the draft #7 p <- q above it;
#   #8 dev <- r, ready, the draft #10 r <- s, and the ready #11 s <- t on top;
#   #12 dev <- u, ready, the drafts #13 u <- v and #14 v <- w above it;
#   #15 dev <- y, ready, with the draft #16 and the ready #17 both based on y.
cat > "$PRS" << 'EOF'
1 dev a o/r
2 a b o/r
3 b c o/r
4 dev x o/r
5 dev c fork/r
6 dev p o/r false
7 p q o/r true
8 dev r o/r false
10 r s o/r true
11 s t o/r false
12 dev u o/r false
13 u v o/r true
14 v w o/r true
15 dev y o/r false
16 y y1 o/r true
17 y y2 o/r false
EOF

stack "a draft runs nothing" true c b true false
stack "the bottom of a stack skips" false a dev true false
stack "the middle of a stack skips" false b a true false
has "…and its reason names the PR above" reason "#3 is based on #9's branch" "$work/out"
stack "the top of a stack runs, from dev" false c b false dev
stack "a PR alone runs, from dev" false x dev false dev
stack "a fork's PR is never below another" false c dev false dev fork/r
stack "a ready PR beside a draft above covers it" false y dev true false
has "…and its reason names the ready one" reason "#17 is based on #9's branch" "$work/out"

stack "a PR with only a draft above runs its own checks" false p dev false dev
expect "…and names the draft" drafts "#7" "$work/out"
stack "the draft above it runs nothing" true q p true false
stack "a PR with two drafts above runs its own checks" false u dev false dev
expect "…and names both" drafts "#13, #14" "$work/out"

stack "a PR below a draft below a ready top skips" false r dev true false
has "…and its reason names the top past the draft" reason "#11 (ready) is above #9 in its stack, past the draft #10" "$work/out"
stack "the draft in the middle runs nothing" true s r true false
stack "the ready top past a draft runs, from dev" false t s false dev

out="$work/out"; : > "$out"
GITHUB_OUTPUT="$out" EVENT=push bash "$work/stack.sh" > /dev/null 2>&1
expect "a push runs" run true "$out"

: > "$out"
FAIL_GH=1 GITHUB_OUTPUT="$out" EVENT=pull_request REPO=o/r OWNER=o DRAFT=false NUMBER=1 HEAD_REF=a \
  HEAD_REPO=o/r BASE_REF=dev STACK=top-only bash "$work/stack.sh" > /dev/null 2>&1
expect "GitHub refusing the list fails open" decided false "$out"

# Decide: a repository whose dev has one commit, and a stack two commits ahead of it.
repo="$work/repo"
git init -q -b dev "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m root
git -C "$repo" update-ref refs/remotes/origin/dev HEAD
git -C "$repo" checkout -q -b c
mkdir -p "$repo/packages/apps/desktop" "$repo/.github/workflows"
echo a > "$repo/packages/apps/desktop/main.ts"
git -C "$repo" add -A && git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m desktop
head_sha="$(git -C "$repo" rev-parse HEAD)"
# `git fetch origin` in decide: point origin at the repository itself.
git -C "$repo" remote add origin "$repo"

decide() { # <case> <projects> <paths> <want run>
  : > "$out"
  (cd "$repo" && GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY=/dev/null DECIDED=false ROOT=dev NUMBER=9 \
    HEAD_SHA="$head_sha" PROJECTS="$2" PATHS="$3" ALWAYS="$always" bash "$work/decide.sh" > /dev/null 2>&1)
  expect "$1" run "$4" "$out"
}

decide "the top with no project or path runs" "" "" true
: > "$out"
(cd "$repo" && GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY=/dev/null DECIDED=false ROOT=dev NUMBER=6 DRAFTS="#7" \
  HEAD_SHA="$head_sha" PROJECTS="" PATHS="" ALWAYS="$always" bash "$work/decide.sh" > /dev/null 2>&1)
expect "a PR with only drafts above runs" run true "$out"
has "…and says why" reason "Only drafts are above #6 (#7)" "$out"
decide "a path the stack changes runs" "" "packages/apps/desktop/*" true
decide "a path the stack does not change skips" "" "packages/apps/console/*" false
decide "projects with no rush.json fail open" "@x/console" "" true

echo b > "$repo/.github/workflows/ci.yml"
git -C "$repo" add -A && git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m workflow
head_sha="$(git -C "$repo" rev-parse HEAD)"
decide "a workflow change runs whatever the paths" "" "packages/apps/console/*" true

: > "$out"
GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY=/dev/null DECIDED=true RUN=false REASON=draft bash "$work/decide.sh" > /dev/null 2>&1
expect "an answer the stack step gave stands" run false "$out"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All cases passed."
