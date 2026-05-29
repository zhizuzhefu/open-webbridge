# Build the daemon. The module root (go.mod) is the repository root, so we
# build the ./open-webbridge-daemon package from there.
BINARY := open-webbridge
PKG := github.com/zhizuzhefu/open-webbridge/open-webbridge-daemon
ROOT := $(shell cd .. && pwd)
INSTALL_DIR := $(HOME)/.open-webbridge/bin
VERSION := $(shell grep -m1 'Version =' internal/config/config.go | sed -E 's/.*"([^"]+)".*/\1/')

.PHONY: build install clean vet test run-version

build:
	cd $(ROOT) && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o open-webbridge-daemon/bin/$(BINARY) ./open-webbridge-daemon
	@echo "built bin/$(BINARY) (v$(VERSION))"

install: build
	mkdir -p $(INSTALL_DIR)
	cp bin/$(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "installed to $(INSTALL_DIR)/$(BINARY)"

vet:
	cd $(ROOT) && go vet ./...

test:
	cd $(ROOT) && go test ./...

run-version: build
	./bin/$(BINARY) version

clean:
	rm -rf bin
