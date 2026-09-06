CC ?= cc
CFLAGS += -O2 -Wall $(shell pkg-config --cflags zlib)
SRCS := $(wildcard src/*.c)
OBJS := $(patsubst src/%.c,build/%.o,$(SRCS))

.PHONY: all clean
all: build/app

build/%.o: src/%.c include/app.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

build/app: $(OBJS)
	$(CC) $^ -o $@ -lz # link

clean:
	rm -rf build
