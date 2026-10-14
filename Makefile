ARENA_MAKEFILE := $(realpath $(lastword $(MAKEFILE_LIST)))
ifeq ($(ARENA_MAKEFILE),)
$(error cannot resolve the Arena Makefile path)
endif
ARENA_ROOT := $(patsubst %/,%,$(dir $(ARENA_MAKEFILE)))
.DEFAULT_GOAL := help

-include $(ARENA_ROOT)/.work/arena/server.mk

ifneq ($(strip $(ACCEPT_MINECRAFT_EULA)),)
ifneq ($(ACCEPT_MINECRAFT_EULA),1)
$(error ACCEPT_MINECRAFT_EULA must be exactly 1 when set)
endif
endif

.PHONY: help server
help:
	@printf '%s\n' 'make server: wait for an external spectator to join, then start the local bot match'


ifeq ($(ACCEPT_MINECRAFT_EULA),1)
server:
	@cd "$(ARENA_ROOT)" && exec ./arena run --scenario scenarios/hunger-six.toml --accept-minecraft-eula --reserve-external-spectator-slot --wait-for-external-player
else
server:
	@printf '%s\n' 'Set ACCEPT_MINECRAFT_EULA=1 to accept the Minecraft EULA and start the server.' >&2
	@exit 3
endif
