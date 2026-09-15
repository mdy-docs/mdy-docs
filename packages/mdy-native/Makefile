# mdy-native — the mdy engine as a binary. No JavaScript engine but lamassu,
# which runs the templates; the walk, the document store, composition and the
# output are C. See ../../docs/desktop-plan.md.
#
#   make build/mdy                the engine, as the `mdy` command
#   make check-engine             its unit checks, twice (see the target)
#   make check-parse              the front end's own checks, no node needed
#   make check-sites              every site here, built BOTH ways and diffed
#   make check-site SITE=<dir>    one site, the same way
#   make check-highlight          highlight.js in lamassu, against lowlight
#   make check-cli                mdy-docs' CLI tests, run against build/mdy
#   make check-alloc              a build with each allocation refused in turn
#   make check-alloc-all          every sweep a native build can run (~8 min)
#   make check-alloc-doc          document mode; check-alloc-dev the server
#   make check-generated          the four generated headers, against their generators
#   make check-alloc-wasm         and through the wasm engine
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
# DEBUG is -g, and the one thing to turn off for a build somebody downloads:
# CI sets it empty, so the artifacts carry no DWARF (which was most of the
# Linux and Windows binaries' size). It reaches the parser's flags too;
# lamassu's archives take theirs from its own Makefile's CFLAGS.
DEBUG   ?= -g
CFLAGS  += -std=gnu11 -Wall -Wextra -O2 $(DEBUG) -I$(LAMASSU)/include
LDLIBS  += -lm

# GNU Make 3.81 — which is the one macOS ships, and the one this is most often
# run under — compares mtimes at SECOND resolution. A prerequisite written half
# a second after the target still reads as "up to date":
#
#     touch out; touch -r out src; <src 0.5s newer within the same second>
#     make  →  `out' is up to date.
#
# Object files do not fix this and neither does anything else in here; the
# comparison is make's. It is worth saying out loud because it has produced a
# wrong answer three times in this repository's review — a FAIL from a binary
# that predated the fix, a PASS from one that predated the bug, and a leak
# measurement that reported clean because `git stash` restored the file within
# the same second as the link. Each time the result described a different
# binary than the one named.
#
# So the warning fires exactly where being wrong costs something: when a check
# target is what was asked for. Ordinary builds stay quiet.
ifeq ($(firstword $(subst ., ,$(MAKE_VERSION))),3)
ifneq ($(filter check-%,$(MAKECMDGOALS)),)
$(warning make $(MAKE_VERSION) compares file times to the second, so an edit made)
$(warning in the same second as the object built from it will not rebuild. If a)
$(warning check result surprises you, `make clean` and run it again before believing it.)
endif
endif

# Windows has no libpthread of its own and mingw's winpthreads is not needed:
# nothing here starts a thread.
ifeq ($(OS),Windows_NT)
  EXE := .exe
  # bcrypt for BCryptGenRandom: the delivery token's randomness (httpd.c).
  LDLIBS += -lws2_32 -lbcrypt
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

LAM_ASAN_LIBS := $(LAMASSU)/build/liblamassu_runtime_asan.a $(LAMASSU)/build/liblamassu_frontend_asan.a
$(LAM_ASAN_LIBS):
	$(MAKE) -C $(LAMASSU) build/liblamassu_runtime_asan.a build/liblamassu_frontend_asan.a

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

# ---- sukkal, in this process ----------------------------------------------
#
# `mdy dev` with no --broker runs the broker itself: sukkal's store and
# routes are C and link straight in, and a request is a direct call to
# sukkal_dispatch — the seam its own WebAssembly build uses. Its delivery
# transport is libcurl and is NOT linked; the local bus pulls instead, as
# mdy-bus's does. See src/broker.c.
#
# Two things about the link. sukkal vendors binjson-structures at a version
# nisaba does not, and 41 names (bjfile_*, bpt_*) are defined by both, so
# sukkal's units are compiled with src/sukkal_rename.h -include'd — the same
# shape as NIS_RENAME. And binjson.c itself is byte-identical in both trees,
# so nisaba's copy serves sukkal too.
SUKKAL := ../../third_party/sukkal-msg
SUKKAL_SRCS := $(SUKKAL)/src/store.c $(SUKKAL)/src/server.c \
               $(SUKKAL)/src/push.c $(SUKKAL)/src/bjtext.c \
               $(SUKKAL)/third_party/binjson-structures/src/bjfile.c \
               $(SUKKAL)/third_party/binjson-structures/src/entrylog.c \
               $(SUKKAL)/third_party/binjson-structures/src/bplustree.c \
               src/memns.c
SUKKAL_INC := -I$(SUKKAL)/include -I$(SUKKAL)/third_party/binjson/include \
              -I$(SUKKAL)/third_party/binjson-structures/include
SUKKAL_FLAGS := -include src/sukkal_rename.h

# Only sukkal's portable half is here — the same list its own wasm build
# links — and src/memns.c stands in for its POSIX shell: a directory in
# memory instead of a descriptor and openat. Nothing in the archive touches
# a filesystem, which is what lets it build on Windows and under emcc alike.
build/libsukkal.a: $(SUKKAL_SRCS) src/sukkal_rename.h src/memns.h
	@mkdir -p build/sukkal
	@for f in $(SUKKAL_SRCS); do \
	  $(CC) -std=gnu11 -O2 $(DEBUG) -Isrc $(SUKKAL_INC) $(SUKKAL_FLAGS) -c $$f -o build/sukkal/`basename $$f .c`.o || exit 1; \
	done
	$(AR) rcs $@ $(addprefix build/sukkal/,$(notdir $(SUKKAL_SRCS:.c=.o)))

build/libsukkal-asan.a: $(SUKKAL_SRCS) src/sukkal_rename.h src/memns.h
	@mkdir -p build/sukkal-asan
	@for f in $(SUKKAL_SRCS); do \
	  $(CC) -std=gnu11 -g -O1 -fsanitize=address -fno-omit-frame-pointer -Isrc $(SUKKAL_INC) $(SUKKAL_FLAGS) -c $$f -o build/sukkal-asan/`basename $$f .c`.o || exit 1; \
	done
	$(AR) rcs $@ $(addprefix build/sukkal-asan/,$(notdir $(SUKKAL_SRCS:.c=.o)))

# ---- the MDY front end, in C ----------------------------------------------
#
# src/parse: the same parser mdy-docs has in JavaScript, producing the same
# tree (87/87 documents of the reference corpus byte for byte), plus the
# YAML reader, the script compiler, the markdown front end and the HTML
# writer. It is here because the front end is where a native build's time
# went: a profile put every frame in the JavaScript layer, and this was the
# largest single thing in it.
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
# lexbor's headers reach src/parse because raw.c is the rehype-raw stage and
# lives there: it is the `.md` front end's last pass, not the engine's first.
PARSE_INC  := -Isrc/parse -Ithird_party/md4c/src -Ithird_party/lexbor/source
PARSE_CFLAGS := -std=c11 -Wall -Wextra -Wshadow -O2 $(DEBUG) $(PARSE_INC) $(UCD_INC)
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

# The same library with the failing allocator forced in, for build/mdy-af.
# Without it the sweep cannot reach block.c's arena, which is where a third
# of the parser's allocations live.
PARSE_AF_OBJS := $(patsubst src/parse/%.c,build/parse-af/%.o,$(PARSE_SRCS))
MD4C_AF_OBJS  := build/parse-af/md4c.o build/parse-af/md4c-entity.o
PARSE_AF_LIB  := build/libmdyparse-af.a

build/parse-af/%.o: src/parse/%.c $(PARSE_HDRS) src/allocfail.h
	@mkdir -p build/parse-af
	$(CC) $(PARSE_CFLAGS) -include src/allocfail.h -c $< -o $@
build/parse-af/md4c.o: third_party/md4c/src/md4c.c src/allocfail.h
	@mkdir -p build/parse-af
	$(CC) $(PARSE_CFLAGS) -include src/allocfail.h -c $< -o $@
build/parse-af/md4c-entity.o: third_party/md4c/src/entity.c src/allocfail.h
	@mkdir -p build/parse-af
	$(CC) $(PARSE_CFLAGS) -include src/allocfail.h -c $< -o $@

$(PARSE_AF_LIB): $(PARSE_AF_OBJS) $(MD4C_AF_OBJS)
	$(AR) rcs $@ $(PARSE_AF_OBJS) $(MD4C_AF_OBJS)

# ...and under AddressSanitizer, for build/mdy-asan and the engine test. An
# instrumented engine linked against an uninstrumented parser catches a
# parser overflow only when it happens to fault, which is not what a
# sanitizer build is for.
ASAN_FLAGS := -g -O1 -fsanitize=address -fno-omit-frame-pointer
PARSE_ASAN_OBJS := $(patsubst src/parse/%.c,build/parse-asan/%.o,$(PARSE_SRCS))
MD4C_ASAN_OBJS  := build/parse-asan/md4c.o build/parse-asan/md4c-entity.o
PARSE_ASAN_LIB  := build/libmdyparse-asan.a

build/parse-asan/%.o: src/parse/%.c $(PARSE_HDRS)
	@mkdir -p build/parse-asan
	$(CC) $(PARSE_CFLAGS) $(ASAN_FLAGS) -c $< -o $@
build/parse-asan/md4c.o: third_party/md4c/src/md4c.c
	@mkdir -p build/parse-asan
	$(CC) $(PARSE_CFLAGS) $(ASAN_FLAGS) -c $< -o $@
build/parse-asan/md4c-entity.o: third_party/md4c/src/entity.c
	@mkdir -p build/parse-asan
	$(CC) $(PARSE_CFLAGS) $(ASAN_FLAGS) -c $< -o $@

$(PARSE_ASAN_LIB): $(PARSE_ASAN_OBJS) $(MD4C_ASAN_OBJS)
	$(AR) rcs $@ $(PARSE_ASAN_OBJS) $(MD4C_ASAN_OBJS)

# stb: three single-file headers, vendored. See third_party/stb/README.md.
STB_INC   := -Ithird_party/stb

# ---- lexbor ----------------------------------------------------------------
#
# HTML5 tree construction, vendored at third_party/lexbor: the tokenizer and
# the insertion modes, which is what turns a `raw` node into real elements and
# repairs what a document got wrong. That README is the argument for it; what
# matters here is that it is five of lexbor's modules and one port file, not
# the project.
#
# Its objects keep their source paths under build/lexbor, where every other
# archive here flattens to a basename: lexbor has eight basenames used twice
# (document.c, element.c, node.c, serialize.c and four more), so flattening
# would silently drop half of each pair.
LX_DIR    := third_party/lexbor/source
LX_INC    := -I$(LX_DIR)
LX_SRCS   := $(wildcard $(LX_DIR)/lexbor/core/*.c $(LX_DIR)/lexbor/ns/*.c \
                        $(LX_DIR)/lexbor/tag/*.c \
                        $(LX_DIR)/lexbor/dom/*.c $(LX_DIR)/lexbor/dom/*/*.c \
                        $(LX_DIR)/lexbor/html/*.c $(LX_DIR)/lexbor/html/*/*.c \
                        $(LX_DIR)/lexbor/html/*/*/*.c \
                        $(LX_DIR)/lexbor/ports/posix/lexbor/core/*.c)
LX_OBJS   := $(patsubst $(LX_DIR)/%.c,build/lexbor/%.o,$(LX_SRCS))
LX_LIB    := build/liblexbor.a

# Three suppressions, and only these three: 138 unused parameters and 44
# shadowed names under the flags src/parse is built with, and one signed
# comparison that only emcc's clang objects to. Vendored code is not edited to
# silence a warning -- images.c puts a pragma round the stb include for the
# same reason -- and they are scoped to these objects, so a new warning in
# first-party code is still an error to somebody reading the build.
LX_CFLAGS := -std=c11 -Wall -Wextra -Wno-unused-parameter -Wno-shadow \
             -Wno-sign-compare -O2 $(DEBUG) $(LX_INC)

build/lexbor/%.o: $(LX_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(LX_CFLAGS) -c $< -o $@

LX_ASAN_OBJS := $(patsubst $(LX_DIR)/%.c,build/lexbor-asan/%.o,$(LX_SRCS))
LX_ASAN_LIB  := build/liblexbor-asan.a
build/lexbor-asan/%.o: $(LX_DIR)/%.c
	@mkdir -p $(dir $@)
	$(CC) $(LX_CFLAGS) $(ASAN_FLAGS) -c $< -o $@
$(LX_ASAN_LIB): $(LX_ASAN_OBJS)
	@mkdir -p build
	$(AR) rcs $@ $(LX_ASAN_OBJS)

$(LX_LIB): $(LX_OBJS)
	@mkdir -p build
	$(AR) rcs $@ $(LX_OBJS)

# A parse of the three shapes that matter, so a build which produces a lexbor
# that cannot repair an unclosed tag says so here rather than in a site diff.
build/lexbor-test$(EXE): test/lexbor.c $(LX_LIB)
	$(CC) -std=c11 -Wall -Wextra -Wshadow -O2 $(DEBUG) $(LX_INC) $< $(LX_LIB) -o $@

# ---- the front end's own checks -------------------------------------------
#
# `make check-parse` needs no node: the parser on constructed input, the HTML
# writer on trees built by hand, the script compiler, the YAML reader and the
# ```data scanner. The harder question — does each agree with mdy-docs'
# JavaScript over real input, byte for byte — is the node-driven targets below
# it, and it is how every rule in src/parse was written: measured against the
# JavaScript rather than read from it.
PARSE_CHECKS := build/parse-test$(EXE) build/html-test$(EXE) build/script-test$(EXE) \
                build/yaml-test$(EXE) build/data-test$(EXE) build/doc-test$(EXE) \
                build/lexbor-test$(EXE)

build/parse-test$(EXE): test/parse.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/html-test$(EXE): test/html.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/script-test$(EXE): test/script.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/yaml-test$(EXE): test/yaml.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/doc-test$(EXE): test/doc.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@

build/data-test$(EXE): test/data.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@

# The drivers the node harnesses run: text in, a tree (or YAML, or documents,
# or JavaScript) out as JSON, one per line, so a diff can say which document.
build/mdyast$(EXE): test/mdyast.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/mdcat$(EXE): test/mdcat.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/yamlcat$(EXE): test/yamlcat.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/linkify$(EXE): test/linkify.c $(PARSE_LIB) $(LX_LIB)
	$(CC) $(PARSE_CFLAGS) $< $(PARSE_LIB) $(LX_LIB) -o $@
build/md4cprobe$(EXE): test/md4cprobe.c $(MD4C_SRCS)
	$(CC) $(PARSE_CFLAGS) test/md4cprobe.c $(MD4C_SRCS) -o $@

.PHONY: check-parse compare check-html check-script check-yaml check-links \
        check-markdown corpus bench check-cli

# bin/mdy.js's own tests (test/cli.test.js), with this binary in its place:
# every case spawns the CLI and asserts on its output and exit code, so the
# same file is the specification for both. MDY_CLI is how the test file
# swaps the executable.
check-cli: build/mdy$(EXE)
	@MDY_CLI="$(abspath build/mdy$(EXE))" node --test ../../test/cli.test.js

# The dev server, which had no test of any kind until a delivery arriving
# before the first good build was found to kill it. Native only, and this
# file rather than ../../test/cli.test.js: the in-process broker is this
# binary's, and bin/mdy.js's dev server has no delivery endpoint to hold to
# the same answer.
check-dev: build/mdy$(EXE)
	@MDY_CLI="$(abspath build/mdy$(EXE))" node --test test/dev.test.js

# What a FILE is, from its extension: .mdy a document, .md markdown, .yaml a
# record. Native-only for the reason check-dev is — node reads every file as a
# document whatever it is called, so there is no shared behaviour here and
# test/cli.test.js is the wrong place for a difference.
check-document: build/mdy$(EXE)
	@MDY_CLI="$(abspath build/mdy$(EXE))" node --test test/document.test.js

# A hostile-input corpus through the SANITIZER build: deep nesting, ill-formed
# UTF-8, truncation, embedded NUL, outsized token counts. Every crash the
# review found took MALFORMED input, which nothing else here feeds — this is
# what makes the next one visible before it ships. See test/hostile.test.js.
.PHONY: check-hostile
check-hostile: build/mdy-asan$(EXE)
	@MDY_ASAN="$(abspath build/mdy-asan$(EXE))" node --test test/hostile.test.js
check-parse: $(PARSE_CHECKS) build/mdyast$(EXE)
	@./build/lexbor-test$(EXE)
	@./build/parse-test$(EXE)
	@./build/html-test$(EXE)
	@./build/script-test$(EXE)
	@./build/yaml-test$(EXE)
	@./build/data-test$(EXE)
	@./build/doc-test$(EXE)

# The differential harnesses. mdy-docs is this repository; the corpora are
# the site next to it. Point CORPUS, SITE and THEME elsewhere as needed.
# Absolute,
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
# under SITE's parent. Nothing is committed; see test/build-corpus.mjs.
# CORPUS_ROOTS is where the `real` group is found — whatever markdown is on
# this machine. Empty builds the SPEC groups alone: 904 documents in 23 KB,
# every one of them from a file in this tree, so it is the same corpus on any
# machine and in CI. That is what `check-markdown` is gated on.
CORPUS_ROOTS ?= $(SITE_ABS)/..

corpus:
	@node test/build-corpus.mjs --roots "$(CORPUS_ROOTS)"

corpus-specs:
	@node test/build-corpus.mjs --roots ""

# The baseline is the 81 spec documents this front end still gets wrong, named
# one per line. Rewriting it is deliberate: see test/markdown-baseline.txt.
corpus-baseline: build/mdcat$(EXE)
	@node test/compare-markdown.mjs --mdy-docs "$(MDY_DOCS_ABS)" \
	  --tool "$(if $(TOOL),$(TOOL),build/mdcat$(EXE))" \
	  --write-baseline test/markdown-baseline.txt

check-markdown: build/mdcat$(EXE)
	@node test/compare-markdown.mjs --mdy-docs "$(MDY_DOCS_ABS)" \
	  --tool "$(if $(TOOL),$(TOOL),build/mdcat$(EXE))" \
	  --baseline test/markdown-baseline.txt

bench: build/mdyast$(EXE)
	@node test/compare.mjs --mdy-docs "$(MDY_DOCS_ABS)" --corpus "$(CORPUS_ABS)" --bench


# ---- highlight.js, in lamassu -------------------------------------------
#
# Fenced code is coloured with highlight.js's own grammars, run inside the
# JavaScript engine this binary already embeds: third_party/highlight.js is a
# fork of highlight.js and lowlight's emitter in lamassu's subset, bundled
# into one script. See its README for what changed and what it is held to.
# Node is a build dependency for this one header; every CI job has it.
HL_DIR := third_party/highlight.js
HL_SRC := $(wildcard $(HL_DIR)/*.js) $(wildcard $(HL_DIR)/languages/*.js) \
          $(HL_DIR)/aliases.json $(HL_DIR)/keyword-scopes.json $(HL_DIR)/VERSION
HL_OUT := build/highlight.lamassu.js
HL_HDR := build/highlight_bundle.h

$(HL_OUT): $(HL_SRC) $(HL_DIR)/build.mjs
	@node $(HL_DIR)/build.mjs

# The same, as a C string constant src/engine.c embeds and loads as the ES
# module "mdy-docs/highlight" the first time a fence asks for colour.
$(HL_HDR): $(HL_SRC) $(HL_DIR)/build.mjs
	@node $(HL_DIR)/build.mjs --c-header $@

$(LAMASSU)/build/lamassu:
	$(MAKE) -C $(LAMASSU) cli

.PHONY: highlight check-highlight
highlight: $(HL_OUT)

# The fork against lowlight, over every source file in this repository plus
# a sample per grammar, under node and under lamassu's CLI. Both must be
# 100%: the first isolates the port, the second the engine.
check-highlight: $(HL_OUT) $(LAMASSU)/build/lamassu
	@node $(HL_DIR)/check.mjs

# ---- the golden outputs ---------------------------------------------------
#
# What the node CLI produces for three deterministic sites, committed so CI can
# check the native backend byte-for-byte on a platform where node cannot run
# the build at all (it needs the WASM engines, which are emscripten build
# products and are not in git). See test/golden/README.md.
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
#
# fixture-awkward earns its place for the opposite reason to fixture-pkg: it is
# made of the inputs that WERE bugs, and check-sites — the only thing that
# would otherwise build it — cannot run in CI at all. Committing its output
# puts an empty .mdy, a `---`-leading .yaml, a `.md` through $.render and a
# corrupt .tif in front of every platform this builds on.
GOLDEN_SITES := test/fixture test/fixture-pkg ../../examples/messaging \
                test/fixture-awkward

.PHONY: golden check-golden check-determinism
golden:
	@for d in $(GOLDEN_SITES); do rm -rf test/golden/`basename $$d`; done
	@for d in $(GOLDEN_SITES); do \
	  node ../../bin/mdy.js build $$d --out test/golden/`basename $$d` > /dev/null || exit 1; \
	done
	@echo "regenerated test/golden/ — read the diff before committing it"

# A golden site whose output moves is worse than no golden site: it goes red
# for a reason that is not a regression. This proves each one is stable across
# the thing a git checkout actually changes — every file's mtime.
check-determinism: build/mdy$(EXE)
	@bin=./build/mdy$(EXE); fail=0; \
	for d in $(GOLDEN_SITES); do \
	  n=`basename $$d`; \
	  rm -rf build/det-$$n-a build/det-$$n-b; \
	  $$bin build $$d --out build/det-$$n-a --quiet || exit 1; \
	  find $$d -type f -exec touch {} \; ; \
	  $$bin build $$d --out build/det-$$n-b --quiet || exit 1; \
	  if diff -r build/det-$$n-a build/det-$$n-b > /dev/null; then \
	    echo "  $$n: stable across an mtime change"; \
	  else \
	    echo "  $$n: OUTPUT MOVES — it cannot be a golden site"; fail=1; \
	  fi; \
	done; \
	exit $$fail

check-golden: build/mdy$(EXE)
	@bin=./build/mdy$(EXE); fail=0; \
	for d in $(GOLDEN_SITES); do \
	  n=`basename $$d`; \
	  rm -rf build/check-$$n; \
	  $$bin build $$d --out build/check-$$n --quiet || exit 1; \
	  if diff -r test/golden/$$n build/check-$$n > /dev/null; then \
	    echo "  $$n: identical to golden"; \
	  else \
	    echo "  $$n: DIFFERS from golden"; diff -r test/golden/$$n build/check-$$n | head -20; fail=1; \
	  fi; \
	done; \
	exit $$fail

.PHONY: check-ingest check-engine check-engine-asan check-site check-sites check-dev check-alloc check-generated \
        check-alloc-all check-alloc-doc check-alloc-dev clean

# A document from text into a nisaba collection, with no JavaScript in it:
# data fences, YAML, binjson, dc_insert_one, and a query back out. This is the
# ingest mdy.js does in JS — `collection.insertOne({ ...doc.data })` — done in
# C, and it is the seam the engine will be built on.
build/ingest-test$(EXE): test/ingest.c src/ingest.c src/nis.c src/oswin.c src/bjval.c src/xalloc.c $(NIS_SRCS) $(PARSE_LIB) $(LX_LIB)
	@mkdir -p build
	$(CC) $(CFLAGS) -Isrc -Ibuild $(NIS_INC) $(SUKKAL_INC) $(PARSE_INC) $(STB_INC) $(NIS_RENAME) \
	  test/ingest.c src/ingest.c src/nis.c src/oswin.c src/bjval.c src/xalloc.c $(NIS_SRCS) $(PARSE_LIB) $(LX_LIB) -o $@ $(LDLIBS)

check-ingest: build/ingest-test$(EXE)
	@./build/ingest-test$(EXE)

# The engine, in the four files it is: the document store and the natives and
# rendering (engine.c), the VM boundary (engine_value.c), the trees a render
# parks (engine_compose.c), and the directory walk with its import graph
# (engine_walk.c). Everything they share is in engine_internal.h, which is a
# PREREQUISITE and not only an include: editing a header used to leave every
# binary that depends on it untouched, and a stale build is a test result that
# means nothing.
ENGINE_SRCS := src/engine.c src/engine_value.c src/engine_compose.c src/engine_walk.c src/ingest.c src/nis.c src/fsx.c src/oswin.c src/images.c src/http.c src/bjval.c src/watch.c src/httpd.c src/broker.c src/xalloc.c

# ---- and the objects they compile to ---------------------------------------
#
# Every engine binary used to be one `cc` over all thirty-one sources. A
# one-character change to cli.c recompiled nisaba's seventeen; `make
# check-engine` after an edit recompiled them again for the test binary; ASan
# a third time. The split into four engine files made that worse, which is
# what §3 of the review said it would.
#
# So: one object per source, and three binaries that link them. cli.c and
# test/engine.c are objects too, so an edit to either relinks and compiles
# nothing else. ASan gets its own directory because its flags differ (-O1,
# -fsanitize=address) and an object built one way is not the other.
#
# -MMD -MP writes a .d beside each .o naming every header that source actually
# opened — including build/highlight_bundle.h and lamassu's and nisaba's, which
# no hand-written list had. That is strictly better than ENGINE_HDRS, which
# named eleven of ours and nothing else, so ENGINE_HDRS is gone. -MP adds a
# phony target per header so that DELETING one is a rebuild rather than a
# "No rule to make target".
#
# Basenames are the object names, so two sources may not share one. They are
# distinct today across all thirty-one; the check below is what says so if a
# future one is not, because the failure otherwise is a silent mis-link.
OBJ_SRCS  := $(ENGINE_SRCS) $(NIS_SRCS)
ENGINE_OBJS := $(addprefix build/obj/,$(notdir $(OBJ_SRCS:.c=.o)))
ASAN_OBJS   := $(addprefix build/obj-asan/,$(notdir $(OBJ_SRCS:.c=.o)))
AF_OBJS     := $(addprefix build/obj-af/,$(notdir $(OBJ_SRCS:.c=.o)))
ifneq ($(words $(ENGINE_OBJS)),$(words $(sort $(ENGINE_OBJS))))
  $(error two of ENGINE_SRCS/NIS_SRCS share a basename; object names would collide)
endif

ENGINE_CPPFLAGS := -Isrc -Ibuild $(NIS_INC) $(SUKKAL_INC) $(PARSE_INC) $(STB_INC) $(NIS_RENAME)
ASAN_CFLAGS     := -std=gnu11 -Wall -g -O1 -fsanitize=address -fno-omit-frame-pointer

# build/mdy-af is build/mdy with one allocation refused. The header is forced
# in rather than included by hand so that the engine sources stay ignorant of
# it -- no #ifdef in a call site, nothing to get out of step with the real
# build. See src/allocfail.c.
AF_CFLAGS       := $(CFLAGS) -include src/allocfail.h

# An explicit rule per source rather than a vpath: the sources come from four
# directories, two of them outside this tree, and a global `vpath %.c` would
# also be consulted for the parser's and the tests', which resolve by exact
# path today and should go on doing so.
define ENGINE_OBJ_RULE
build/obj/$(notdir $(1:.c=.o)): $(1) $$(HL_HDR)
	@mkdir -p build/obj
	$$(CC) $$(CFLAGS) $$(ENGINE_CPPFLAGS) -MMD -MP -c $$< -o $$@
build/obj-asan/$(notdir $(1:.c=.o)): $(1) $$(HL_HDR)
	@mkdir -p build/obj-asan
	$$(CC) $$(ASAN_CFLAGS) $$(ENGINE_CPPFLAGS) -I$$(LAMASSU)/include -MMD -MP -c $$< -o $$@
build/obj-af/$(notdir $(1:.c=.o)): $(1) $$(HL_HDR) src/allocfail.h
	@mkdir -p build/obj-af
	$$(CC) $$(AF_CFLAGS) $$(ENGINE_CPPFLAGS) -MMD -MP -c $$< -o $$@
endef
$(foreach s,$(OBJ_SRCS),$(eval $(call ENGINE_OBJ_RULE,$(s))))

build/obj/cli.o: src/cli.c $(HL_HDR)
	@mkdir -p build/obj
	$(CC) $(CFLAGS) $(ENGINE_CPPFLAGS) -MMD -MP -c $< -o $@
build/obj-asan/cli.o: src/cli.c $(HL_HDR)
	@mkdir -p build/obj-asan
	$(CC) $(ASAN_CFLAGS) $(ENGINE_CPPFLAGS) -I$(LAMASSU)/include -MMD -MP -c $< -o $@
build/obj-af/cli.o: src/cli.c $(HL_HDR) src/allocfail.h
	@mkdir -p build/obj-af
	$(CC) $(AF_CFLAGS) $(ENGINE_CPPFLAGS) -MMD -MP -c $< -o $@
# The shim is the one file the -include must not reach: it defines what the
# macros rename to, and would rename itself into infinite recursion.
build/obj-af/allocfail.o: src/allocfail.c src/allocfail.h
	@mkdir -p build/obj-af
	$(CC) $(CFLAGS) $(ENGINE_CPPFLAGS) -MMD -MP -c $< -o $@
# Named for the binary, not the file: src/engine.c already owns engine.o.
build/obj/engine-test.o: test/engine.c $(HL_HDR)
	@mkdir -p build/obj
	$(CC) $(CFLAGS) $(ENGINE_CPPFLAGS) -MMD -MP -c $< -o $@

ENGINE_LIBS := $(PARSE_LIB) $(LX_LIB) build/libsukkal.a $(LAM_LIBS)
AF_LIBS     := $(PARSE_AF_LIB) $(LX_LIB) build/libsukkal.a $(LAM_LIBS)
ASAN_LIBS   := $(PARSE_ASAN_LIB) $(LX_ASAN_LIB) build/libsukkal-asan.a $(LAM_ASAN_LIBS)

-include $(ENGINE_OBJS:.o=.d) $(ASAN_OBJS:.o=.d) $(AF_OBJS:.o=.d) \
         build/obj/cli.d build/obj-asan/cli.d build/obj-af/cli.d \
         build/obj-af/allocfail.d build/obj/engine-test.d

# One document, end to end, with no JavaScript engine but lamassu — the three
# passes of src/mdy.js done in C. No JavaScript engine but lamassu is linked
# into this binary.
build/engine-test$(EXE): build/obj/engine-test.o $(ENGINE_OBJS) $(ENGINE_LIBS)
	@mkdir -p build
	$(CC) $(CFLAGS) build/obj/engine-test.o $(ENGINE_OBJS) $(ENGINE_LIBS) -o $@ $(LDLIBS)

# The command under AddressSanitizer, every library it links included, for
# the hostile corpus (check-hostile). A use-after-free in the boundary between
# the tree, the document store and the VM is invisible without it: a freed key
# cell is silently reused and a property becomes a different one.
build/mdy-asan$(EXE): build/obj-asan/cli.o $(ASAN_OBJS) $(ASAN_LIBS)
	@mkdir -p build
	$(CC) $(ASAN_CFLAGS) build/obj-asan/cli.o $(ASAN_OBJS) $(ASAN_LIBS) -o $@ $(LDLIBS)

# The engine test the same way (check-engine-asan).
build/obj-asan/engine-test.o: test/engine.c $(HL_HDR)
	@mkdir -p build/obj-asan
	$(CC) $(ASAN_CFLAGS) $(ENGINE_CPPFLAGS) -I$(LAMASSU)/include -MMD -MP -c $< -o $@
build/engine-test-asan$(EXE): build/obj-asan/engine-test.o $(ASAN_OBJS) $(ASAN_LIBS)
	@mkdir -p build
	$(CC) $(ASAN_CFLAGS) build/obj-asan/engine-test.o $(ASAN_OBJS) $(ASAN_LIBS) -o $@ $(LDLIBS)

# The same driver with a single allocation refused, chosen by
# MDY_ALLOC_FAIL_NTH. check-alloc sweeps n over a whole build; see check-alloc.
build/mdy-af$(EXE): build/obj-af/cli.o $(AF_OBJS) build/obj-af/allocfail.o $(AF_LIBS)
	@mkdir -p build
	$(CC) $(CFLAGS) build/obj-af/cli.o $(AF_OBJS) build/obj-af/allocfail.o $(AF_LIBS) -o $@ $(LDLIBS)

build/mdy$(EXE): build/obj/cli.o $(ENGINE_OBJS) $(ENGINE_LIBS)
	@mkdir -p build
	$(CC) $(CFLAGS) build/obj/cli.o $(ENGINE_OBJS) $(ENGINE_LIBS) -o $@ $(LDLIBS)

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

# The same checks with every library instrumented, and the collector at
# every safe point: the two together are what turn a use-after-free at the
# VM boundary into a named line rather than a property that quietly became
# a different one.
check-engine-asan: build/engine-test-asan$(EXE)
	@MDY_GC_STRESS=1 ./build/engine-test-asan$(EXE)

# A whole site built both ways and diffed. SITE names the directory, and
# defaults to the site next to this repository — the same SITE the front end's
# harnesses above read — but the corpus that matters is whichever one you have.
#
#   make check-site SITE=<dir>
check-site: build/mdy$(EXE)
	@node test/compare-site.mjs "$(SITE)"

# THE SUITE. Every site in this repository, built both ways and diffed.
#
# It replaced running mdy-docs' JavaScript test files inside a second engine.
# That proved "mdy-docs runs unchanged on the native backend" — a claim about
# a binary that no longer exists. This proves the thing that matters now: the
# C engine and mdy-docs agree, on real input, byte for byte. Pointing it at
# these five found eight bugs in an engine that already built a 93-page site
# identically, and not one of them failed a unit test.
#
# Every site is expected to be identical, and the check fails if a count
# moves in either direction. Two used to differ by an EXACT amount:
#
#   blog       1: its search index tokenizes its own `$.text`, which holds a
#                 composition token, and a token's id depends on the renders
#                 before it. The render memo (src/engine.c) hits where
#                 mdy-docs' hits and holds a render under its key, as
#                 compose.js does, so the ids agree.
#   docs-site  2: its pages emit raw HTML through the markdown front end, and
#                 md4c hands a raw block over with its final newline where
#                 remark's `html` node has none — a blank line after every
#                 raw block, until src/parse/markdown.c dropped it.
# fixture-awkward is a site made of the inputs that WERE bugs — see its
# main.mdy, which names the finding each file stands on. The 2026-09 review
# called a fixture like it the most valuable single addition it could name,
# and it earned that on its first run: it found the `.md` table divergence
# that is now fixed in markdown.c,
# which no unit test could see because both sides had the same bytes in a
# different order.
CHECK_SITES := ../../examples/blog:0 ../../examples/docs-site:0 \
               ../../examples/messaging:0 test/fixture:0 \
               test/fixture-pkg:0 test/fixture-awkward:0
#
# Every allocation in a build, refused one at a time.
#
# An allocation whose result is used unchecked is easy to fix and impossible
# to verify by reading, because the path never runs unless an allocation
# actually fails. build/mdy-af is build/mdy
# with the allocator replaced by one that refuses the nth request
# (src/allocfail.c), and this sweeps n across a whole build.
#
# The invariant is not "it does not crash". It is:
#
#     a run that exits 0 produced the SAME SITE as a run that was not
#     interfered with; a run that could not must say so and exit non-zero.
#
# Silently dropping a page is worse than the crash it replaces, because the
# build reports success with files missing -- and that is what 306 of the
# first sweep's 1,809 ordinals did. The first sweep found 13 segfaults and
# those 306; every corpus below is clean now.
#
# SITE picks the corpus, because each larger one reached sites the one before
# it could not -- the fixture has no hashtags, no `.yaml` data files and no
# pictures, and the blog's sweep found eleven more because of it. The sweep
# is parallel: one ordinal is one process with its own output directory, so
# serially-25-minutes becomes a minute, and a check somebody runs is worth
# more than a thorough one they do not.
#
#     fixture 1,808 / 6s      blog 14,298 / 1m      docs-site 17,747 / 5m30
#     fixture-awkward 2,300 / 4s
#
# fixture-awkward is the default because it is strictly more: 493 more
# allocations than `fixture`, a `.md` front end `fixture` has none of, and
# FASTER, since its documents are small where the fixture's entry does real
# work. Sweeping it the first time found three unchecked strdups in
# render_tree_out that `fixture` cannot reach -- it has no `.md` to render --
# and an md4c allocation failure that md4c itself drops.
#
# ONE VARIABLE, FOUR TARGETS. build, dev and wasm all take it, because the
# reason `fixture` was too small is a property of the SITE and not of the
# command: whichever of the three runs, it is the documents that decide which
# code the sweep can reach. Leaving dev and wasm behind on `fixture` leaves
# the .md path unswept even after check-alloc has moved on.
#
#     build 2,300 / 4s     dev 2,402 / 4s     wasm 2,299 / 30s
#
# check-alloc-doc is the one that cannot follow. `mdy <file.mdy> -o` opens ONE
# file and walks no directory, so `$.render({ path: "page.md" })` from it
# answers "found no such document": there is no single-document shape that
# reaches the markdown front end at all.
ALLOC_SITE ?= test/fixture-awkward

check-alloc: build/mdy$(EXE) build/mdy-af$(EXE)
	@node test/alloc-sweep.mjs --bin build/mdy-af$(EXE) --ref build/mdy$(EXE) \
	  --site "$(ALLOC_SITE)" $(if $(JOBS),--jobs $(JOBS),)

# The other two commands, because sweeping only `build` leaves the paths that
# only `document` and `dev` reach untested -- and those are where the last
# fourteen unchecked allocations were found.
#
# `document` is one file through `mdy <path> -o`: one source, no directory
# walk, no static/ copy. Its fixture has to be DETERMINISTIC, which rules out
# examples/document-set.mdy -- it prints document ids, and they are new every
# run, so a sweep against it reports every ordinal as wrong.
#
# `dev` restates the invariant, because a server has neither "the same site"
# nor "a reported failure" to offer: it either serves the same site, or says
# it could not, and saying so includes refusing the request. What it must
# never do is answer 200 with bytes that are not the site's.
check-alloc-doc: build/mdy$(EXE) build/mdy-af$(EXE)
	@fail=0; for s in ../../examples/elements.mdy ../../examples/hashtags.mdy \
	                  ../../examples/invoice.mdy ../../examples/roster.mdy; do \
	  node test/alloc-sweep.mjs --bin build/mdy-af$(EXE) --ref build/mdy$(EXE) \
	    --mode document --site "$$s" $(if $(JOBS),--jobs $(JOBS),) || fail=1; \
	done; exit $$fail

check-alloc-dev: build/mdy$(EXE) build/mdy-af$(EXE)
	@node test/alloc-sweep.mjs --bin build/mdy-af$(EXE) --ref build/mdy$(EXE) \
	  --mode dev --site "$(ALLOC_SITE)" $(if $(JOBS),--jobs $(JOBS),)

# Everything a native sweep can reach, which is what a pre-push or a nightly
# wants: four sites in build mode, four documents, and the dev server. About
# nine minutes. fixture-awkward is FIRST because it is the fastest and the one
# most likely to fail -- the .md front end is the newest thing under the shim.
check-alloc-all: build/mdy$(EXE) build/mdy-af$(EXE)
	@fail=0; for s in test/fixture-awkward test/fixture ../../examples/blog \
	          ../../examples/docs-site; do \
	  node test/alloc-sweep.mjs --bin build/mdy-af$(EXE) --ref build/mdy$(EXE) \
	    --site "$$s" $(if $(JOBS),--jobs $(JOBS),) || fail=1; \
	done; \
	$(MAKE) --no-print-directory check-alloc-doc || fail=1; \
	$(MAKE) --no-print-directory check-alloc-dev || fail=1; \
	exit $$fail

# The four generated headers, against their generators.
#
# src/toolkit.h, emoji_table.h, props_table.h and schema_table.h are generated
# from mdy-docs' own sources and from `property-information` in node_modules.
# They are checked in so a build never needs node — and nothing compared them,
# so an upstream change to how an HTML attribute maps would have arrived as a
# silent divergence from mdy-docs rather than a failing check (§4).
#
# Two of the generators had also never run as their own instructions said:
# they built `file://` + a RELATIVE path, and a URL reads what follows `//`
# as the host. Fixed with this.
#
# Needs node and the node_modules mdy-docs installs; not in CI for the reason
# check-sites is not.
check-generated:
	@fail=0; tmp=$$(mktemp -d); \
	for pair in scripts/generate-props.mjs:src/parse/props_table.h \
	            scripts/generate-schema.mjs:src/parse/schema_table.h \
	            scripts/generate-emoji.mjs:src/parse/emoji_table.h \
	            scripts/generate-alerts.mjs:src/parse/alert_table.h; do \
	  g=$${pair%%:*}; h=$${pair##*:}; \
	  node $$g "$(MDY_DOCS_ABS)" > "$$tmp/out.h" || { echo "  $$g FAILED to run"; fail=1; continue; }; \
	  if diff -q "$$h" "$$tmp/out.h" >/dev/null; then printf '  %-22s in sync\n' "$$h"; \
	  else printf '  %-22s DIFFERS from %s\n' "$$h" "$$g"; diff "$$h" "$$tmp/out.h" | head -20; fail=1; fi; \
	done; \
	node scripts/toolkit.mjs > "$$tmp/toolkit.h" 2>/dev/null && \
	  { if diff -q src/toolkit.h "$$tmp/toolkit.h" >/dev/null; then printf '  %-22s in sync\n' src/toolkit.h; \
	    else printf '  %-22s DIFFERS from scripts/toolkit.mjs\n' src/toolkit.h; fail=1; fi; } || \
	  { echo "  scripts/toolkit.mjs FAILED to run"; fail=1; }; \
	rm -rf "$$tmp"; exit $$fail

check-sites: build/mdy$(EXE)
	@fail=0; for s in $(CHECK_SITES); do \
	  dir=$${s%:*}; want=$${s##*:}; \
	  printf '%-34s ' "$$dir"; \
	  node test/compare-site.mjs "$$dir" --expect "$$want" || fail=1; \
	done; exit $$fail



# ---- wasm: the same engine, in a browser --------------------------------
#
# The fourth target. Every source above compiles with emcc as it is — the
# engine's only platform surface is fsx.c, which is POSIX over an in-memory
# filesystem here (emscripten's MEMFS), and nisaba's storage is memory
# already. So a build in the browser is: write the site's files into MEMFS,
# run main() as the CLI would be run, read dist/ back out. wasm/index.mjs is
# that wrapper, wasm/check-golden.mjs runs it under node against test/golden/,
# and wasm/index.html is the same thing with a directory picker.
#
# lamassu compiles to its own archive first, and it has to: NIS_RENAME must
# reach nisaba's regex engine and NOT baru-re, or both engines' copies of the
# four names would be renamed to the same thing and collide again. (A
# `build/libnisaba.a` rule used to stand above for the same reason; nothing
# ever linked it, since every binary compiles NIS_SRCS directly.)
EMCC ?= emcc
EMAR ?= emar
LAM_SRCS := $(wildcard $(LAMASSU)/src/runtime/*.c) $(wildcard $(LAMASSU)/src/frontend/*.c) \
            $(LAMASSU)/third_party/baru-re/src/re_lexer.c $(LAMASSU)/third_party/baru-re/src/re_parser.c \
            $(LAMASSU)/third_party/baru-re/src/re_compiler.c $(LAMASSU)/third_party/baru-re/src/re_vm.c
LAM_INC  := -I$(LAMASSU)/include -I$(LAMASSU)/src -I$(LAMASSU)/src/runtime -I$(LAMASSU)/src/frontend \
            -I$(LAMASSU)/third_party/baru-re/include -DLAMASSU_HAS_REGEX
WASM_OUT := build/wasm/mdy-native.mjs

WASM_LAM_OBJS := $(addprefix build/wasm/lam/,$(notdir $(LAM_SRCS:.c=.o)))
build/wasm/liblamassu.a: $(LAM_SRCS) $(wildcard $(LAMASSU)/include/*.h $(LAMASSU)/src/*/*.h)
	@mkdir -p build/wasm/lam
	@for f in $(LAM_SRCS); do \
	  $(EMCC) -O2 -std=c11 -D_POSIX_C_SOURCE=200809L $(LAM_INC) -c $$f -o build/wasm/lam/`basename $$f .c`.o || exit 1; \
	done
	$(EMAR) rcs $@ $(WASM_LAM_OBJS)

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
	$(EMAR) rcs $@ $(addprefix build/wasm/parse/,$(notdir $(PARSE_SRCS:.c=.o) $(MD4C_SRCS:.c=.o)))

# Objects keep their paths here too, for the reason the native rule gives.
build/wasm/liblexbor.a: $(LX_SRCS)
	@mkdir -p build/wasm/lexbor
	@for f in $(LX_SRCS); do \
	  o=build/wasm/lexbor/`echo $$f | sed 's|^$(LX_DIR)/||; s|/|_|g; s|\.c$$|.o|'`; \
	  $(EMCC) $(LX_CFLAGS) -c $$f -o $$o || exit 1; \
	done
	$(EMAR) rcs $@ $(foreach f,$(LX_SRCS),build/wasm/lexbor/$(subst /,_,$(patsubst $(LX_DIR)/%.c,%.o,$(f))))

build/wasm/libsukkal.a: $(SUKKAL_SRCS) src/sukkal_rename.h src/memns.h
	@mkdir -p build/wasm/sukkal
	@for f in $(SUKKAL_SRCS); do \
	  $(EMCC) -std=gnu11 -O2 -Isrc $(SUKKAL_INC) $(SUKKAL_FLAGS) -c $$f -o build/wasm/sukkal/`basename $$f .c`.o || exit 1; \
	done
	$(EMAR) rcs $@ $(addprefix build/wasm/sukkal/,$(notdir $(SUKKAL_SRCS:.c=.o)))

# The one target still built in a single invocation: it is built rarely, and
# emcc spends its time linking rather than compiling. Every first-party header
# is a prerequisite by name, since a single invocation writes no .d file to
# learn them from.
WASM_HDRS := $(wildcard src/*.h) $(PARSE_HDRS) $(HL_HDR)
WASM_LINK := -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createMdyNative -sENVIRONMENT=web,worker,node \
             -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8388608 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
             -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=FS,callMain
$(WASM_OUT): src/cli.c $(ENGINE_SRCS) $(NIS_SRCS) $(WASM_HDRS) build/wasm/libmdyparse.a build/wasm/liblexbor.a build/wasm/liblamassu.a build/wasm/libsukkal.a
	@mkdir -p build/wasm
	$(EMCC) -O2 -std=gnu11 -Wall -Wextra $(ENGINE_CPPFLAGS) -I$(LAMASSU)/include \
	  src/cli.c $(ENGINE_SRCS) $(NIS_SRCS) build/wasm/libmdyparse.a build/wasm/liblexbor.a build/wasm/libsukkal.a build/wasm/liblamassu.a \
	  $(WASM_LINK) -o $@

# The same module with the failing allocator forced in, for check-alloc-wasm.
# The parser gets its own instrumented archive for the reason the native sweep
# needed one: block.c's arena is a third of the parser's allocations.
WASM_AF_OUT := build/wasm/mdy-native-af.mjs

build/wasm/libmdyparse-af.a: $(PARSE_SRCS) $(PARSE_HDRS) $(MD4C_SRCS) src/allocfail.h
	@mkdir -p build/wasm/parse-af
	@for f in $(PARSE_SRCS) $(MD4C_SRCS); do \
	  $(EMCC) $(PARSE_CFLAGS) -include src/allocfail.h -c $$f -o build/wasm/parse-af/`basename $$f .c`.o || exit 1; \
	done
	$(EMAR) rcs $@ $(addprefix build/wasm/parse-af/,$(notdir $(PARSE_SRCS:.c=.o) $(MD4C_SRCS:.c=.o)))

# The shim itself is a separate object because -include applies to every
# source on the command line, and it is the one file the macros must not
# reach: it defines what they rename to.
build/wasm/allocfail.o: src/allocfail.c src/allocfail.h
	@mkdir -p build/wasm
	$(EMCC) -O2 -std=gnu11 -Isrc -c $< -o $@

# mdy_af_arm and mdy_af_total are exported because emscripten's getenv reads
# its own ENV and cannot see the host's environment.
$(WASM_AF_OUT): src/cli.c $(ENGINE_SRCS) $(NIS_SRCS) $(WASM_HDRS) build/wasm/allocfail.o src/allocfail.h \
                build/wasm/libmdyparse-af.a build/wasm/liblexbor.a build/wasm/liblamassu.a build/wasm/libsukkal.a
	@mkdir -p build/wasm
	$(EMCC) -O2 -std=gnu11 -Wall -Wextra $(ENGINE_CPPFLAGS) -I$(LAMASSU)/include \
	  -include src/allocfail.h \
	  src/cli.c $(ENGINE_SRCS) $(NIS_SRCS) build/wasm/allocfail.o \
	  build/wasm/libmdyparse-af.a build/wasm/liblexbor.a build/wasm/libsukkal.a build/wasm/liblamassu.a \
	  $(WASM_LINK) -sEXPORTED_FUNCTIONS=_main,_mdy_af_arm,_mdy_af_total \
	  -o $@

# The same sweep through the wasm engine, which is a different question and
# not a duplicate of check-alloc.
#
# A run that cannot finish ends with `_Exit(1)`. Under emscripten main() is
# reached through callMain with EXIT_RUNTIME=0, so an exit arrives at the host
# as a thrown ExitStatus rather than a process that stopped -- and wasm/
# index.mjs reads the files out of MEMFS AFTERWARDS and hands them back beside
# the status. If that status were lost, a caller would be given a half-written
# site with nothing saying so, which is the whole failure the sweep exists to
# rule out. This is what says the status survives.
#
# Serial, and about a minute for the fixture: one module instance per ordinal,
# because the memo and MEMFS both persist inside an instance and sharing one
# would serve the next build the last one's renders.
check-alloc-wasm: $(WASM_AF_OUT)
	@node wasm/check-alloc.mjs --site "$(if $(ALLOC_WASM_SITE),$(ALLOC_WASM_SITE),$(ALLOC_SITE))"

.PHONY: wasm check-wasm check-alloc-wasm serve-wasm
wasm: $(WASM_OUT)

serve-wasm: $(WASM_OUT)
	@node wasm/serve.mjs

# The golden sites, built through the wasm engine under node, diffed against
# test/golden/ — the same bar the native binary is held to.
check-wasm: $(WASM_OUT)
	@node wasm/check-golden.mjs

clean:
	rm -rf build
