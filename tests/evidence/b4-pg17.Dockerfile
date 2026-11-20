# Runtime image for the B4 PG17 evidence runner (formal supplement).
#
# Built on the hosted runner during the same natural pull_request run; nothing here is a
# pre-existing local image. The base is the official postgres:17 index digest that the verified
# main run 44618201957 pulled (Debian 13, PostgreSQL 17.12) and that Docker Hub still serves for tag 17.
# Everything added on top is listed in image-provenance.txt (package versions, image id).
#
# Node is NOT baked in: the workflow bind-mounts the runner's setup-node tree read-only so the
# runtime Node is the same binary that built the standalone artifact.
ARG B4_PG_BASE=postgres:17@sha256:b60e90042aa6b8dbecd58e224b3e36114dbf8ad754465264c2476ad58a86e45c
FROM ${B4_PG_BASE}

# ip and ss for the isolation checks in b4-pg17.sh. Only iproute2 is fetched from the distro;
# util-linux (findmnt, setpriv), bash and GNU tools are already in the base.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends iproute2; \
    rm -rf /var/lib/apt/lists/*

# Static BusyBox with crond. The workflow downloads busybox-static_1.36.1-6ubuntu3.1 (same pins as the
# mail-evidence job), verifies the deb and the binary SHA-256, and places the binary in the build context.
COPY --chmod=0755 busybox /usr/bin/busybox
