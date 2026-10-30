#!/bin/sh
# Explicit static configuration; leave DHCP unchanged unless invoked manually.
set -eu
: "${ADDRESS:?Set the VM IPv4 address}"
: "${PREFIX:?Set the CIDR prefix}"
: "${NETMASK:?Set the IPv4 netmask}"
: "${GATEWAY:?Set the gateway}"
: "${DNS:?Set space-separated DNS server addresses}"
# Validate every value before changing networking or writing configuration.
for value in "$ADDRESS" "$NETMASK" "$GATEWAY" $DNS; do
    echo "$value" | awk -F. 'NF != 4 {exit 1} {for(i=1;i<=4;i++) if ($i !~ /^[0-9]+$/ || $i>255) exit 1}' || exit 1
done
case "$PREFIX" in ''|*[!0-9]*) exit 1 ;; esac
[ "$PREFIX" -ge 1 ] && [ "$PREFIX" -le 32 ]
killall dhcpcd udhcpc 2>/dev/null || true
cat > /etc/network/interfaces <<EOF
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet static
    address ${ADDRESS}
    netmask ${NETMASK}
    gateway ${GATEWAY}
    dns-nameservers ${DNS}
EOF
ip -4 addr flush dev eth0
ip addr add "${ADDRESS}/${PREFIX}" dev eth0
ip link set eth0 up
ip route replace default via "$GATEWAY" dev eth0
: > /etc/resolv.conf
for server in $DNS; do printf 'nameserver %s\n' "$server" >> /etc/resolv.conf; done
