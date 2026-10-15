.PHONY: install dev api build run test
install:
	cd frontend && npm ci

dev:
	cd frontend && npm run dev

api:
	cd backend && go run ./cmd/server

build:
	cd frontend && npm run build
	python3 scripts/copy-dist.py
	cd backend && go build -o ../bin/folio ./cmd/server

run: build
	./bin/folio

test:
	cd frontend && npm run lint && npm test && npm run test:e2e
	cd backend && go test ./...
