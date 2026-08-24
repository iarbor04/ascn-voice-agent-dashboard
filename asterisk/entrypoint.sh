#!/bin/sh
set -e
if [ -n "$ASTERISK_EXTERNAL_IP" ]; then
  sed -i "s/__EXTERNAL_IP__/$ASTERISK_EXTERNAL_IP/g" /etc/asterisk/pjsip.conf
  echo "ASCN: внешний адрес для SDP — $ASTERISK_EXTERNAL_IP"
else
  sed -i '/__EXTERNAL_IP__/d' /etc/asterisk/pjsip.conf
  echo "ASCN: ASTERISK_EXTERNAL_IP не задан — Asterisk будет ставить в SDP свой адрес контейнера, за NAT это даст тишину в трубке"
fi
exec asterisk -f -vvv
