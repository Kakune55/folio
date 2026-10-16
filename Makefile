
CONTAINER_ENGINE ?= docker
IMAGE_FORMAT_FLAGS = $(if $(filter podman,$(notdir $(CONTAINER_ENGINE))),--format=docker,)

# Platform-specific configuration
ifeq ($(OS),Windows_NT)
    PYTHON := python
    EXE_EXT := .exe
    SHELL := cmd.exe
    .SHELLFLAGS := /C

    # Environment variable assignment through cmd.exe
    API_ENV := set "FOLIO_WORKSPACE=../workspace" && set "FOLIO_APP_DATA=../app-data" && set "FOLIO_SECURE_COOKIE=false" &&
    RUN_ENV := set "FOLIO_SECURE_COOKIE=false" &&

    # cmd.exe cannot execute "./bin/folio.exe"; use a Windows-style path
    RUN_BIN := bin\folio.exe

    SH := bash
else
    PYTHON := python3
    EXE_EXT :=

    API_ENV := FOLIO_WORKSPACE="$${FOLIO_WORKSPACE:-../workspace}" FOLIO_APP_DATA="$${FOLIO_APP_DATA:-../app-data}" FOLIO_SECURE_COOKIE=false
    RUN_ENV := FOLIO_SECURE_COOKIE=false

    RUN_BIN := ./$(BIN)

    SH := sh
endif

BIN := bin/folio$(EXE_EXT)

.PHONY: install dev api build run test qa tls image container-test container-review backup-test

install:
	cd frontend && npm ci

dev:
	cd frontend && npm run dev

api:
	cd backend && $(API_ENV) go run ./cmd/server

build:
	cd frontend && npm run build
	$(PYTHON) scripts/copy-dist.py
	cd backend && go build -o ../$(BIN) ./cmd/server

run: build
	$(RUN_ENV) $(RUN_BIN)

test:
	cd frontend && npm run lint && npm test && npm run test:e2e
	cd backend && go test ./...
	$(PYTHON) scripts/backup-test.py

tls:
	$(SH) scripts/setup-local-tls.sh

image:
	$(CONTAINER_ENGINE) build $(IMAGE_FORMAT_FLAGS) -t folio:local .

container-test:
	$(PYTHON) scripts/container-acceptance.py

container-review:
	$(PYTHON) scripts/container-review.py

backup-test:
	$(PYTHON) scripts/backup-test.py

qa:
	cd frontend && npm run test:qa
