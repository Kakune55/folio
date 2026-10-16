CONTAINER_ENGINE ?= docker
IMAGE_FORMAT_FLAGS = $(if $(filter podman,$(notdir $(CONTAINER_ENGINE))),--format=docker,)

.PHONY: install dev api build run test qa tls image container-test backup-test
install:
	cd frontend && npm ci

dev:
	cd frontend && npm run dev

api:
	cd backend && FOLIO_WORKSPACE="$${FOLIO_WORKSPACE:-../workspace}" FOLIO_APP_DATA="$${FOLIO_APP_DATA:-../app-data}" FOLIO_SECURE_COOKIE=false go run ./cmd/server

build:
	cd frontend && npm run build
	python3 scripts/copy-dist.py
	cd backend && go build -o ../bin/folio ./cmd/server

run: build
	FOLIO_SECURE_COOKIE=false ./bin/folio

test:
	cd frontend && npm run lint && npm test && npm run test:e2e
	cd backend && go test ./...
	python3 scripts/backup-test.py

tls:
	sh scripts/setup-local-tls.sh

image:
	$(CONTAINER_ENGINE) build $(IMAGE_FORMAT_FLAGS) -t folio:local .

container-test:
	python3 scripts/container-acceptance.py

backup-test:
	python3 scripts/backup-test.py

qa:
	cd frontend && npm run test:qa
