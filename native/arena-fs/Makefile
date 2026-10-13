ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
OUTPUT := $(ROOT)/.work/arena-fs/arena-fs
RACE_OUTPUT := $(ROOT)/.work/arena-fs/arena-fs-race-helper
CLONE_RACE_OUTPUT := $(ROOT)/.work/arena-fs/arena-fs-clone-race-helper
CC ?= cc

.PHONY: build
build:
	@mkdir -p "$(ROOT)/.work/tmp" "$(dir $(OUTPUT))"
	TMPDIR="$(ROOT)/.work/tmp" $(CC) -std=c11 -O2 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wstrict-prototypes -Wmissing-prototypes -o "$(OUTPUT)" "$(CURDIR)/arena-fs.c"

.PHONY: race-helper
race-helper:
	@mkdir -p "$(ROOT)/.work/tmp" "$(dir $(RACE_OUTPUT))"
	TMPDIR="$(ROOT)/.work/tmp" $(CC) -std=c11 -O2 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wstrict-prototypes -Wmissing-prototypes -o "$(RACE_OUTPUT)" "$(CURDIR)/tests/unlink-race.c"

.PHONY: clone-race-helper
clone-race-helper:
	@mkdir -p "$(ROOT)/.work/tmp" "$(dir $(CLONE_RACE_OUTPUT))"
	TMPDIR="$(ROOT)/.work/tmp" $(CC) -std=c11 -O2 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wstrict-prototypes -Wmissing-prototypes -o "$(CLONE_RACE_OUTPUT)" "$(CURDIR)/tests/clone-race.c"
