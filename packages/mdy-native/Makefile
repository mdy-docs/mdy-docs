# mdy-native — the mdy engine as a binary. No JavaScript engine but lamassu,
# which runs the templates; the walk, the document store, composition and the
# output are C. See ../../docs/desktop-plan.md.
#
#   make build/mdy-build          the engine, as a command
#   make check-engine             its unit checks, twice (see the target)
#   make check-parse              the front end's own checks, no node needed
#   make check-sites              every site here, built BOTH ways and diffed
#   make check-site SITE=<dir>    one site, the same way
#   make wasm                     the same engine as WebAssembly (needs emcc)
#   make check-wasm               the golden sites through it, under node
#   make serve-wasm               and a page that builds a site in a browser
#
# The suite is check-sites: mdy-docs' own JavaScript against this engine over
# real input. It is node that drives it, and node that says what the answer
# should be — there is no second implementation of the expectations to drift.
#
# PORTABILITY. Everything here is plain C with no dependency on a system
# package: lamassu and nisaba are submodules, the front end is src/parse, and
# md4c and stb are vendored. The only files that know which operating system
# this is are src/fsx.c and src/nis.c, because both engines are platform-clean
# — lamassu has no #ifdefs at all and nisaba's I/O is behind its bj_io
# callbacks. See docs/desktop-plan.md, Phase 4.

NISABA  ?= ../../third_party/nisaba-db
LAMASSU ?= ../../third_party/lamassu-js

# gnu11, not c11. glibc hides POSIX declarations under a strict standard —
# strdup came back as an implicit declaration on Linux and st_mtim as an
# unknown field, both of which compile fine on macOS, which exposes them
# regardless. lamassu's own Makefile carries the same note and reaches for
# -D_POSIX_C_SOURCE; gnu11 gets the same result and also works under mingw.
CFLAGS  += -std=gnu11 -Wall -Wextra -O2 -g -I$(LAMASSU)/include
LDLIBS  += -lm

# Windows has no libpthread of its own and mingw's winpthreads is not needed:
# nothing here starts a thread.
ifeq ($(OS),Windows_NT)
  EXE := .exe
else
  LDLIBS += -lpthread
  EXE :=
endif

# src/oswin.c is in every link, on every platform: it is the Win32 half of
# fsx.c and nis.c and is empty under #ifdef _WIN32 elsewhere. Listing it only
# under Windows_NT is how it went missing when this file was rewritten.

# ---- lamassu --------------------------------------------------------------
#
# Its two archives link directly now. They used to need a pre-link pass
# (`ld -r -all_load -unexported_symbol _js_dtoa`) because both engines defined
# js_dtoa — ld64-only, which made macOS the one platform this could be done on
# at all. lamassu's is `static` as of 52f0bfd, and a symbol-table comparison
# says that was the only name the two archives had in common: 181 exports
# against 273, one overlap.
LAM_LIBS := $(LAMASSU)/build/liblamassu_runtime.a $(LAMASSU)/build/liblamassu_frontend.a

$(LAM_LIBS):
	$(MAKE) -C $(LAMASSU) libs

# ---- nisaba ---------------------------------------------------------------
#
# All of nisaba's C compiles with cc and no changes — including the files named
# *_wasm.c, whose EMSCRIPTEN_KEEPALIVE is a no-op off-target and one of which
# holds the regex entry points rather than mere exports. db_wasm.c is the one
# genuine exception: it is the WASM export layer, and a native host is what
# replaces it.
#
# Its storage is not portable either, and that is the seam working:
# `bjio_host(fd)` reaches into Module.bjioHandles, a table of JS
# FileSystemSyncAccessHandle objects. bj_io is four callbacks, so a native host
# supplies its own — see src/nis.c.
NIS_SRCS := \
  $(NISABA)/wasm/src/db_keyenc.c $(NISABA)/wasm/src/regex.c \
  $(NISABA)/wasm/src/db_query.c $(NISABA)/wasm/src/db_update.c $(NISABA)/wasm/src/db.c \
  $(NISABA)/third_party/binjson/src/binjson.c \
  $(NISABA)/third_party/binjson-structures/src/bjfile.c \
  $(NISABA)/third_party/binjson-structures/src/hostio.c \
  $(NISABA)/third_party/binjson-structures/src/bplustree.c \
  $(NISABA)/third_party/binjson-structures/src/geo.c \
  $(NISABA)/third_party/binjson-structures/src/rtree.c \
  $(NISABA)/third_party/binjson-structures/src/diff.c \
  $(NISABA)/third_party/binjson-structures/src/textlog.c \
  $(NISABA)/third_party/binjson-structures/src/stemmer.c \
  $(NISABA)/third_party/binjson-structures/src/textindex.c \
  $(NISABA)/third_party/regex-engine/src/regexp.c \
  $(NISABA)/third_party/regex-engine/src/regex_wasm.c

NIS_INC := -I$(NISABA)/wasm/include -I$(NISABA)/third_party/binjson/include \
           -I$(NISABA)/third_party/binjson-structures/include \
           -I$(NISABA)/third_party/regex-engine/include

# TWO REGEX ENGINES IN ONE BINARY, and they are not the same code.
#
# nisaba vendors mdy-docs/regex-engine; lamassu has moved to mdy-docs/baru-re,
# which is its successor — same ancestry, different version (baru-re 0.5.0 lets
# the embedder supply the allocator, among other things). Neither prefixes its
# symbols, so four names are defined by both: an exact-duplicate link error.
#
# This is worth understanding rather than papering over, because the previous
# build DID paper over it. It pre-linked lamassu into one relocatable object
# with `ld -r -all_load`, which loads every symbol unconditionally, and then
# offered nisaba as an archive — so nisaba's regexp.o was simply never pulled,
# and any call it made to one of these four resolved to LAMASSU's differently
# versioned implementation. Silent, and the wrong kind of wrong.
#
# Renaming nisaba's four at compile time keeps each engine's calls inside its
# own engine, needs no change to either upstream, and works on every compiler.
# It also fails LOUDLY if the overlap ever grows: a new shared name is a new
# duplicate-symbol error, not a new silent binding.
#
# The real fix is for nisaba to use baru-re too, so there is one regex engine
# in the binary instead of two. That is an API migration and it is noted in
# docs/desktop-plan.md rather than done here.
NIS_RENAME := -Dcompile_into=nis_re_compile_into -Dparse_alt=nis_re_parse_alt \
              -Dvm_execute_internal=nis_re_vm_execute_internal \
              -Dvm_get_indices=nis_re_vm_get_indices

build/libnisaba.a: $(NIS_SRCS)
	@mkdir -p build/nis
	@for f in $(NIS_SRCS); do \
	  $(CC) -std=gnu11 -O2 $(NIS_INC) $(NIS_RENAME) -c $$f -o build/nis/`basename $$f .c`.o || exit 1; \
	done
	$(AR) rcs $@ build/nis/*.o

# ---- the MDY front end, in C ----------------------------------------------
#
# src/parse: the same parser mdy-docs has in JavaScript, producing the same
# tree (87/87 documents of the reference corpus byte for byte), plus the
# YAML reader, the script compiler, the markdown front end and the HTML
# writer. It is here because the front end is where a native build's time
# went: a profile put every frame in the JavaScript layer, and this was the
# largest single thing in it. See docs/parser.md.
#
# It was github.com/mdy-docs/parse, a repo of its own, and is folded in here
# because nothing else uses it. Its two dependencies are handled differently:
# md4c is vendored at third_party/md4c, and baru-re's generated Unicode
# tables — the parser wants ucd.h and nothing else of it — are read from the
# copy lamassu already carries, so there is one baru-re in this tree rather
# than two that could drift.
#
# c11 and -Wshadow rather than this package's gnu11: the parser has no
# platform #ifdefs and no libc beyond malloc/free/str*/snprintf, and building
# it strictly is how that stays true.
PARSE_SRCS := $(wildcard src/parse/*.c)
PARSE_HDRS := $(wildcard src/parse/*.h)
PARSE_OBJS := $(patsubst src/parse/%.c,build/parse/%.o,$(PARSE_SRCS))
MD4C_SRCS  := third_party/md4c/src/md4c.c third_party/md4c/src/entity.c
MD4C_OBJS  := build/parse/md4c.o build/parse/md4c-entity.o
UCD_INC    := -I$(LAMASSU)/third_party/baru-re/include
PARSE_INC  := -Isrc/parse -Ithird_party/md4c/src
PARSE_CFLAGS := -std=c11 -Wall -Wextra -Wshadow -O2 -g $(PARSE_INC) $(UCD_INC)
PARSE_LIB  := build/libmdyparse.a

build/parse/%.o: src/parse/%.c $(PARSE_HDRS)
	@mkdir -p build/parse
	$(CC) $(PARSE_CFLAGS) -c $< -o $@

build/parse/md4c.o: third_party/md4c/src/md4c.c
	@mkdir -p build/parse
	$(CC) $(PARSE_CFLAGS) -c $< -o $@

build/parse/md4c-entity.o: third_party/md4c/src/entity.c
	@mkdir -p build/parse
	$(CC) $(PARSE_CFLAGS) -c $< -o $@

$(PARSE_LIB): $(PARSE_OBJS) $(MD4C_OBJS)
	$(AR) rcs $@ $(PARSE_OBJS) $(MD4C_OBJS)

# stb: three single-file headers, vendored. See third_party/stb/README.md.
STB_INC   := -Ithird_party/stb

# ---- the front end's own checks -------------------------------------------
#
# `make check-parse` needs no node: the parser on constructed input, the HTML
# writer on trees built by hand, the script compiler, the YAML reader and the
# ```data scanner. The harder question — does each agree with mdy-docs'
# JavaScript over real input, byte for byte — is the node-driven targets below
# it, and it is how every rule in src/parse was written: measured against the
# JavaScript rather than read from it. See docs/parser.md.
PARSE_CHECKS := build/parse-test$(EXE) build/html-test$(EXE) build/script-test$(EXE) \
                build/yaml-test$(EXE) build/data-test$(EXE)

build/parse-test$(EXE): test/parse.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/html-test$(EXE): test/html.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/script-test$(EXE): test/script.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/yaml-test$(EXE): test/yaml.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/data-test$(EXE): test/data.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@

# The drivers the node harnesses run: text in, a tree (or YAML, or documents,
# or JavaScript) out as JSON, one per line, so a diff can say which document.
build/mdyast$(EXE): test/mdyast.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/mdcat$(EXE): test/mdcat.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/doccat$(EXE): test/doccat.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/yamlcat$(EXE): test/yamlcat.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/datacat$(EXE): test/datacat.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/linkify$(EXE): test/linkify.c $(PARSE_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) -o $@
build/md4cprobe$(EXE): test/md4cprobe.c $(MD4C_SRCS)
	$(CC) $(PARSE_CFLAGS) test/md4cprobe.c $(MD4C_SRCS) -o $@

.PHONY: check-parse compare check-html check-script check-yaml check-links \
        check-markdown corpus bench
check-parse: $(PARSE_CHECKS) build/mdyast$(EXE)
	@./build/parse-test$(EXE)
	@./build/html-test$(EXE)
	@./build/script-test$(EXE)
	@./build/yaml-test$(EXE)
	@./build/data-test$(EXE)

# The differential harnesses. mdy-docs is this repository; the corpora are
# the site next to it, which is where the reference numbers in docs/parser.md
# come from. Point CORPUS, SITE and THEME elsewhere as needed. Absolute,
# because the harnesses `import()` mdy-docs' modules from the path they are
# given, and a relative one would resolve against test/ rather than here.
MDY_DOCS ?= ../..
CORPUS   ?= ../../../../site/corpus
SITE     ?= ../../../../site
THEME    ?= ../../../../style-antiquity
MDY_DOCS_ABS := $(abspath $(MDY_DOCS))
CORPUS_ABS   := $(abspath $(CORPUS))
SITE_ABS     := $(abspath $(SITE))
THEME_ABS    := $(abspath $(THEME))

# Does the PARSER produce mdy-docs' tree? Document by document, byte for byte,
# with the first differences grouped by shape; --first shows one in full.
compare: build/mdyast$(EXE)
	@node test/compare.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(CORPUS_ABS)"

# The WRITER against hast-util-to-html — the same tree through both, so a
# difference has nowhere else to have come from — then end to end.
check-html: build/mdyast$(EXE)
	@node test/compare-html.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(SITE_ABS)"

# The SCRIPT layer against compileScript: same document in, byte-identical
# JavaScript out. A difference here is different behaviour, not a different tree.
check-script: build/mdyast$(EXE)
	@node test/compare-script.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(SITE_ABS)"

# Every front matter block, ```data fence and .yaml file the site holds, read
# here and by the `yaml` package, compared as JSON.
check-yaml: build/yamlcat$(EXE)
	@node test/compare-yaml.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(SITE_ABS)" --corpus "$(THEME_ABS)"

# URL boundaries against linkify-it, whose rules are nobody's guess.
check-links: build/linkify$(EXE)
	@node test/linkify.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(CORPUS_ABS)"

# The markdown front end against remark, over a borrowed corpus — the
# CommonMark and GFM specs, md4c's extension specs, and real .md files found
# under SITE's parent. Nothing is committed; see scripts-build-corpus.mjs.
corpus:
	@node scripts-build-corpus.mjs --roots "$(SITE_ABS)/.."

check-markdown: build/mdcat$(EXE)
	@node test/compare-markdown.mjs --mdy-docs "$(MDY_DOCS_ABS)" --tool "$(if $(TOOL),$(TOOL),build/mdcat$(EXE))"

bench: build/mdyast$(EXE)
	@node test/compare.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(CORPUS_ABS)" --bench


# ---- the golden outputs ---------------------------------------------------
#
# What the node CLI produces for three deterministic sites, committed so CI can
# check the native backend byte-for-byte on a platform where node cannot run
# the build at all (it needs the WASM engines, which are emscripten build
# products and are not in git). See golden/README.md.
# DETERMINISTIC SITES ONLY, and that is checked rather than assumed — build,
# touch every source, build again, diff. examples/docs-site is NOT here for
# exactly that reason: it renders a source file's mtime, and a git checkout
# sets mtimes to checkout time, so its output can never match a committed
# reference. `make check-determinism` is the test.
#
# fixture-pkg earns its place: it imports a PACKAGE, so its layouts and JS
# modules resolve against that package's directory rather than the site's.
# That is the case Windows is most likely to get wrong, because imports.js
# decides "inside the package" by string prefix on an absolute path.
GOLDEN_SITES := fixture fixture-pkg ../../examples/messaging

.PHONY: golden check-golden check-determinism
golden:
	@rm -rf golden/fixture golden/fixture-pkg golden/messaging
	@for d in $(GOLDEN_SITES); do \
	  node ../../bin/mdy.js build $$d --out golden/`basename $$d` > /dev/null || exit 1; \
	done
	@echo "regenerated golden/ — read the diff before committing it"

# A golden site whose output moves is worse than no golden site: it goes red
# for a reason that is not a regression. This proves each one is stable across
# the thing a git checkout actually changes — every file's mtime.
check-determinism: build/mdy-build$(EXE)
	@bin=./build/mdy-build$(EXE); fail=0; \
	for d in $(GOLDEN_SITES); do \
	  n=`basename $$d`; \
	  rm -rf build/det-$$n-a build/det-$$n-b; \
	  $$bin $$d --out build/det-$$n-a --quiet || exit 1; \
	  find $$d -type f -exec touch {} \; ; \
	  $$bin $$d --out build/det-$$n-b --quiet || exit 1; \
	  if diff -r build/det-$$n-a build/det-$$n-b > /dev/null; then \
	    echo "  $$n: stable across an mtime change"; \
	  else \
	    echo "  $$n: OUTPUT MOVES — it cannot be a golden site"; fail=1; \
	  fi; \
	done; \
	exit $$fail

check-golden: build/mdy-build$(EXE)
	@bin=./build/mdy-build$(EXE); fail=0; \
	for d in $(GOLDEN_SITES); do \
	  n=`basename $$d`; \
	  rm -rf build/check-$$n; \
	  $$bin $$d --out build/check-$$n --quiet || exit 1; \
	  if diff -r golden/$$n build/check-$$n > /dev/null; then \
	    echo "  $$n: identical to golden"; \
	  else \
	    echo "  $$n: DIFFERS from golden"; diff -r golden/$$n build/check-$$n | head -20; fail=1; \
	  fi; \
	done; \
	exit $$fail

.PHONY: check-ingest check-engine check-site check-sites clean

# A document from text into a nisaba collection, with no JavaScript in it:
# data fences, YAML, binjson, dc_insert_one, and a query back out. This is the
# ingest mdy.js does in JS — `collection.insertOne({ ...doc.data })` — done in
# C, and it is the seam the engine will be built on.
build/ingest-test$(EXE): test/ingest.c src/ingest.c src/nis.c src/oswin.c $(NIS_SRCS) $(PARSE_LIB)
	@mkdir -p build
	$(CC) $(CFLAGS) -Isrc $(NIS_INC) $(PARSE_INC) $(STB_INC) $(NIS_RENAME) \
	  test/ingest.c src/ingest.c src/nis.c src/oswin.c $(NIS_SRCS) $(PARSE_LIB) -o $@ $(LDLIBS)

check-ingest: build/ingest-test$(EXE)
	@./build/ingest-test$(EXE)

# One document, end to end, with no JavaScript engine but lamassu — the three
# passes of src/mdy.js done in C. No JavaScript engine but lamassu is linked
# into this binary.
build/engine-test$(EXE): test/engine.c src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c $(NIS_SRCS) $(LAM_LIBS) $(PARSE_LIB)
	@mkdir -p build
	$(CC) $(CFLAGS) -Isrc $(NIS_INC) $(PARSE_INC) $(STB_INC) $(NIS_RENAME) \
	  test/engine.c src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c $(NIS_SRCS) \
	  $(PARSE_LIB) $(LAM_LIBS) -o $@ $(LDLIBS)

# The same driver under AddressSanitizer. A use-after-free in the boundary
# between the tree, the document store and the VM is invisible without it:
# a freed key cell is silently reused and a property becomes a different one.
build/mdy-build-asan$(EXE): src/build_main.c src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c $(NIS_SRCS) $(LAM_LIBS) $(PARSE_LIB)
	@mkdir -p build
	$(CC) -std=gnu11 -Wall -g -O1 -fsanitize=address -fno-omit-frame-pointer \
	  -Isrc $(NIS_INC) $(PARSE_INC) $(STB_INC) $(NIS_RENAME) -I$(LAMASSU)/include \
	  src/build_main.c src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c $(NIS_SRCS) \
	  $(PARSE_LIB) $(LAM_LIBS) -o $@ $(LDLIBS)

build/mdy-build$(EXE): src/build_main.c src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c $(NIS_SRCS) $(LAM_LIBS) $(PARSE_LIB)
	@mkdir -p build
	$(CC) $(CFLAGS) -Isrc $(NIS_INC) $(PARSE_INC) $(STB_INC) $(NIS_RENAME) \
	  src/build_main.c src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c $(NIS_SRCS) \
	  $(PARSE_LIB) $(LAM_LIBS) -o $@ $(LDLIBS)

# Twice: once normally, once collecting at EVERY safe point.
#
# The stress pass is not belt-and-braces. This engine hands the VM values it
# has just built, and one reachable only from the C stack is invisible to the
# collector; freeing it does not crash, it makes a property silently become a
# different property. Under a normal collector that needs a run long enough to
# collect at the wrong moment — it was found by diffing a 93-page site, where
# one link in nine hundred pointed at the wrong page. Under stress the same
# fault shows up in the fourth check.
check-engine: build/engine-test$(EXE)
	@./build/engine-test$(EXE)
	@echo "-- again, collecting at every safe point"
	@MDY_GC_STRESS=1 ./build/engine-test$(EXE)

# A whole site built both ways and diffed. SITE names the directory, and
# defaults to the site next to this repository — the same SITE the front end's
# harnesses above read — but the corpus that matters is whichever one you have.
#
#   make check-site SITE=<dir>
check-site: build/mdy-build$(EXE)
	@node scripts-compare-site.mjs "$(SITE)"

# THE SUITE. Every site in this repository, built both ways and diffed.
#
# It replaced running mdy-docs' JavaScript test files inside a second engine.
# That proved "mdy-docs runs unchanged on the native backend" — a claim about
# a binary that no longer exists. This proves the thing that matters now: the
# C engine and mdy-docs agree, on real input, byte for byte. Pointing it at
# these five found eight bugs in an engine that already built a 93-page site
# identically, and not one of them failed a unit test.
#
# Two sites differ on purpose, by an EXACT amount, and the check fails if
# either count moves in either direction:
#
#   blog       1: its search index tokenizes its own `$.text` output, which
#                 contains a composition TOKEN — and a token's id depends on
#                 how many renders came before it. mdy-docs memoises a render
#                 on (document, request); this engine does not, so it holds
#                 more trees and the ids run ahead.
#   docs-site  2: its pages emit raw HTML for the markdown front end to stitch
#                 back, which is rehype-raw's HTML5 round trip. md4c does not
#                 do it, and the difference is blank lines around the block.
CHECK_SITES := ../../examples/blog:1 ../../examples/docs-site:2 \
               ../../examples/messaging:0 fixture:0 fixture-pkg:0
check-sites: build/mdy-build$(EXE)
	@fail=0; for s in $(CHECK_SITES); do \
	  dir=$${s%:*}; want=$${s##*:}; \
	  printf '%-34s ' "$$dir"; \
	  node scripts-compare-site.mjs "$$dir" --expect "$$want" || fail=1; \
	done; exit $$fail



# ---- wasm: the same engine, in a browser --------------------------------
#
# The fourth target. Every source above compiles with emcc as it is — the
# engine's only platform surface is fsx.c, which is POSIX over an in-memory
# filesystem here (emscripten's MEMFS), and nisaba's storage is memory
# already. So a build in the browser is: write the site's files into MEMFS,
# run main() as the CLI would be run, read dist/ back out. wasm/index.mjs is
# that wrapper, wasm/check-golden.mjs runs it under node against golden/, and
# wasm/index.html is the same thing with a directory picker.
#
# lamassu compiles to its own archive first, for the reason libnisaba.a
# exists above: NIS_RENAME must reach nisaba's regex engine and NOT baru-re,
# or both engines' copies of the four names would be renamed to the same
# thing and collide again.
EMCC ?= emcc
EMAR ?= emar
LAM_SRCS := $(wildcard $(LAMASSU)/src/runtime/*.c) $(wildcard $(LAMASSU)/src/frontend/*.c) \
            $(LAMASSU)/third_party/baru-re/src/re_lexer.c $(LAMASSU)/third_party/baru-re/src/re_parser.c \
            $(LAMASSU)/third_party/baru-re/src/re_compiler.c $(LAMASSU)/third_party/baru-re/src/re_vm.c
LAM_INC  := -I$(LAMASSU)/include -I$(LAMASSU)/src -I$(LAMASSU)/src/runtime -I$(LAMASSU)/src/frontend \
            -I$(LAMASSU)/third_party/baru-re/include -DLAMASSU_HAS_REGEX
ENGINE_SRCS := src/engine.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c
WASM_OUT := build/wasm/mdy-native.mjs

build/wasm/liblamassu.a: $(LAM_SRCS)
	@mkdir -p build/wasm/lam
	@for f in $(LAM_SRCS); do \
	  $(EMCC) -O2 -std=c11 -D_POSIX_C_SOURCE=200809L $(LAM_INC) -c $$f -o build/wasm/lam/`basename $$f .c`.o || exit 1; \
	done
	$(EMAR) rcs $@ build/wasm/lam/*.o

# -sSTACK_SIZE as lamassu's own package build sets it: the interpreter and
# the parser both recurse. INVOKE_RUN=0 and EXIT_RUNTIME=0 so main() is
# called by the wrapper, once per build, and MEMFS is still there afterwards
# to read dist/ out of.
# The parser too, with its own flags and nothing of nisaba's on the line:
# nisaba's regex engine carries a ucd.h of its own, older than baru-re's, and
# with NIS_INC ahead of UCD_INC the parser's `#include "ucd.h"` found that one
# and lost three of the tables it reads.
build/wasm/libmdyparse.a: $(PARSE_SRCS) $(PARSE_HDRS) $(MD4C_SRCS)
	@mkdir -p build/wasm/parse
	@for f in $(PARSE_SRCS) $(MD4C_SRCS); do \
	  $(EMCC) $(PARSE_CFLAGS) -c $$f -o build/wasm/parse/`basename $$f .c`.o || exit 1; \
	done
	$(EMAR) rcs $@ build/wasm/parse/*.o

$(WASM_OUT): src/build_main.c $(ENGINE_SRCS) $(NIS_SRCS) build/wasm/libmdyparse.a build/wasm/liblamassu.a
	@mkdir -p build/wasm
	$(EMCC) -O2 -std=gnu11 -Isrc $(NIS_INC) $(NIS_RENAME) $(PARSE_INC) $(STB_INC) -I$(LAMASSU)/include \
	  src/build_main.c $(ENGINE_SRCS) $(NIS_SRCS) build/wasm/libmdyparse.a build/wasm/liblamassu.a \
	  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMdyNative -sENVIRONMENT=web,worker,node \
	  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8388608 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
	  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
	  -o $@

.PHONY: wasm check-wasm serve-wasm
wasm: $(WASM_OUT)

serve-wasm: $(WASM_OUT)
	@node wasm/serve.mjs

# The golden sites, built through the wasm engine under node, diffed against
# golden/ — the same bar the native binary is held to.
check-wasm: $(WASM_OUT)
	@node wasm/check-golden.mjs

clean:
	rm -rf build
