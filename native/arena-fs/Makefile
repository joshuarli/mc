ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
OUTPUT := $(ROOT)/.work/arena-fs/arena-fs
CC ?= cc

.PHONY: build
build:
	@mkdir -p "$(ROOT)/.work/tmp" "$(dir $(OUTPUT))"
	TMPDIR="$(ROOT)/.work/tmp" $(CC) -std=c11 -O2 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wstrict-prototypes -Wmissing-prototypes -o "$(OUTPUT)" "$(CURDIR)/arena-fs.c"
