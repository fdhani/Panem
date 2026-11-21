# panem-forwarder: one per machine. Build from the repo root:
#   docker build -f packages/forwarder/Dockerfile -t ghcr.io/fdhani/panem/forwarder:0.2.0 .
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --production --filter @panem/forwarder \
 && bun build --compile --minify packages/forwarder/src/main.ts --outfile /forwarder

FROM alpine:3.20
RUN apk add --no-cache libstdc++ libgcc
COPY --from=build /forwarder /usr/local/bin/forwarder
VOLUME /data
EXPOSE 7599 7600-7699
ENTRYPOINT ["/usr/local/bin/forwarder"]
