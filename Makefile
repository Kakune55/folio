.PHONY: install dev api build run test
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
