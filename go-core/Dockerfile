FROM golang:1.27.1-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /amr-core ./cmd/amr-core

FROM scratch
COPY --from=build /amr-core /amr-core
COPY --from=build /usr/local/go/lib/time/zoneinfo.zip /zoneinfo.zip
ENV ZONEINFO=/zoneinfo.zip
USER 65532:65532
ENTRYPOINT ["/amr-core"]
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 CMD ["/amr-core", "healthcheck"]
