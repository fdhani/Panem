# Optional: a prebuilt forwarder image. Panem doesn't need it: by default the controller copies
# the forwarder's code to each machine and runs it with the official oven/bun image. To use an
# image instead, build it from the repo root and set "forwarder": { "image": "<tag>" } in config:
#   docker build -f packages/forwarder/Dockerfile -t panem-forwarder:local .
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
 && bun build --compile --minify packages/forwarder/src/main.ts --outfile /forwarder

FROM alpine:3.20
RUN apk add --no-cache libstdc++ libgcc
COPY --from=build /forwarder /usr/local/bin/forwarder
VOLUME /data
EXPOSE 7599 7600-7699
ENTRYPOINT ["/usr/local/bin/forwarder"]
