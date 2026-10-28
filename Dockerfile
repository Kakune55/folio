# syntax=docker/dockerfile:1
ARG NODE_IMAGE=docker.io/library/node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
ARG GO_IMAGE=docker.io/library/golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS backend
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
COPY --from=frontend /src/frontend/dist ./web/dist
ARG TARGETOS
ARG TARGETARCH
RUN test "$TARGETOS" = linux && test -n "$TARGETARCH" && \
    GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build -trimpath -ldflags='-s -w' -o /out/folio ./cmd/server && \
    mkdir -p /out/workspace /out/app-data /out/tmp && \
    chmod 0700 /out/workspace /out/app-data && chmod 1777 /out/tmp

FROM scratch
COPY --from=backend /out/folio /folio
COPY --from=backend --chown=1000:1000 /out/workspace /workspace
COPY --from=backend --chown=1000:1000 /out/app-data /app-data
COPY --from=backend --chown=1000:1000 /out/tmp /tmp
USER 1000:1000
ENV FOLIO_ADDR=0.0.0.0:8080 FOLIO_WORKSPACE=/workspace FOLIO_APP_DATA=/app-data FOLIO_SECURE_COOKIE=true
EXPOSE 8080
# VOLUME ["/workspace", "/app-data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["/folio", "-healthcheck"]
ENTRYPOINT ["/folio"]
