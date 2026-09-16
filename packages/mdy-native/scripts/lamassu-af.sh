#!/bin/sh
# lamassu's two archives as one, compiled with the failing allocator forced in
# (see src/allocfail.h), for build/mdy-af. lamassu's own Makefile keeps its
# objects in one place per flavour, so a third flavour is built here from the
# source lists and flags its Makefile database reports, rather than by asking
# it to build into a directory it does not have.
#
#   scripts/lamassu-af.sh <lamassu dir> <archive to write> <allocfail.h>
set -e
lam=$1; out=$2; shim=$3
vars=$(make -s -C "$lam" -pn 2>/dev/null)
get() { printf '%s\n' "$vars" | sed -n "s/^$1 :\{0,1\}= //p" | head -1; }
# The include flags are relative to lamassu's directory, so compile from it;
# the outputs are named absolutely.
outdir=$(cd "$(dirname "$out")" && pwd)
out="$outdir/$(basename "$out")"
objdir="$outdir/lamassu-af"
mkdir -p "$objdir"
cc=${CC:-cc}
objs=""
for f in $(get RUNTIME_SRC) $(get FRONTEND_SRC); do
  o="$objdir/$(basename "$f" .c).o"
  (cd "$lam" && $cc $(get WARNINGS) -O2 -g -include "$shim" $(get INC) $(get REGEX_FLAGS) -c "$f" -o "$o")
  objs="$objs $o"
done
for f in $(get RE_SRC); do
  o="$objdir/re-$(basename "$f" .c).o"
  (cd "$lam" && $cc $(get RE_WARN) -O2 -g -include "$shim" $(get RE_INC) -c "$f" -o "$o")
  objs="$objs $o"
done
rm -f "$out"
${AR:-ar} rcs "$out" $objs
