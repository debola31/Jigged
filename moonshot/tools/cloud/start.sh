#!/bin/sh
# The cloud render worker's start (Dockerfile beside it): join the tailnet as an ephemeral node, then take frame
# ranges from the hub until the instance is stopped. Its outbox and cache die with it; a lease it held lapses and the
# hub hands the range to another worker.
set -e
: "${TS_AUTHKEY:?an ephemeral Tailscale auth key}" "${FARM_TOKEN:?the hub's queue token}"
NAME="cloud-$(hostname | cut -c1-8)"
tailscaled --tun=userspace-networking --state=mem: --socks5-server=localhost:1055 \
    --outbound-http-proxy-listen=localhost:1055 >/tmp/tailscaled.log 2>&1 &
sleep 3
tailscale up --authkey="$TS_AUTHKEY" --hostname="$NAME"
mkdir -p /data/queue
printf %s "$FARM_TOKEN" > /data/queue/token
export MOONSHOT_DATA=/data http_proxy=http://localhost:1055
exec python3 -u -m moonshot.orchestrate.worker --name "$NAME" --kinds render_frames --gpu-mem 24 --device OPTIX \
    --blender /opt/blender/blender --trainual /opt/renderer
