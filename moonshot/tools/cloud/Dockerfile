# The cloud reserve's render worker (docs/moonshot/shop-and-pipeline-plan.md §8; checklist §7): a rented GPU that joins
# the farm over Tailscale and takes frame ranges from the hub's queue like any other worker. Nothing here is built or
# pushed until the reserve is triggered with the user's approval.
#
#   docker build -f moonshot/tools/cloud/Dockerfile --build-arg BLENDER_SHA256=<sha256 of the tarball> \
#       --build-arg TAILSCALE_VERSION=<x.y.z> -t jigged-render-worker .          # from the repo root
#   docker run --gpus all -e TS_AUTHKEY=<ephemeral key> -e FARM_TOKEN=<hub token> jigged-render-worker
#
# The renderer it runs is copied into the build context's renderer/ folder before building (the farm's copy at
# C:\jigged-data\renderer\trainual, or the ported moonshot/render once it lands); it is not in git.
FROM nvidia/cuda:12.6.3-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils python3 python3-numpy \
        libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 libgl1 libegl1 \
    && rm -rf /var/lib/apt/lists/*

# Blender 5.2.3 LTS, the farm's pinned version, checked against its published checksum
ARG BLENDER_SHA256
RUN test -n "$BLENDER_SHA256" \
    && curl -fsSL -o /tmp/blender.tar.xz https://download.blender.org/release/Blender5.2/blender-5.2.3-linux-x64.tar.xz \
    && echo "$BLENDER_SHA256  /tmp/blender.tar.xz" | sha256sum -c - \
    && mkdir /opt/blender && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 && rm /tmp/blender.tar.xz

# Tailscale, pinned, run in userspace: rented containers rarely allow a TUN device
ARG TAILSCALE_VERSION
RUN test -n "$TAILSCALE_VERSION" \
    && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz" | tar -xz -C /tmp \
    && mv /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale /tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled /usr/local/bin/

COPY moonshot/__init__.py moonshot/config.py /opt/jigged/moonshot/
COPY moonshot/orchestrate /opt/jigged/moonshot/orchestrate
COPY moonshot/render /opt/jigged/moonshot/render
COPY renderer /opt/renderer
COPY moonshot/tools/cloud/start.sh /opt/jigged/start.sh
RUN sed -i 's/\r$//' /opt/jigged/start.sh

WORKDIR /opt/jigged
ENTRYPOINT ["sh", "/opt/jigged/start.sh"]
