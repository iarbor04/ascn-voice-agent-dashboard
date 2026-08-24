#!/bin/sh
set -e
if [ -n "$ASTERISK_EXTERNAL_IP" ]; then
  sed -i "s/__EXTERNAL_IP__/$ASTERISK_EXTERNAL_IP/g" /etc/asterisk/pjsip.conf
  echo "ASCN: внешний адрес для SDP — $ASTERISK_EXTERNAL_IP"
else
  sed -i '/__EXTERNAL_IP__/d' /etc/asterisk/pjsip.conf
  echo "ASCN: ASTERISK_EXTERNAL_IP не задан — Asterisk будет ставить в SDP свой адрес контейнера, за NAT это даст тишину в трубке"
fi
# Пароль AMI берём из окружения: в репозитории лежит только заглушка.
if [ -n "${ASTERISK_AMI_PASSWORD:-}" ]; then
  sed -i "s/__AMI_PASSWORD__/${ASTERISK_AMI_PASSWORD}/" /etc/asterisk/manager.conf
else
  sed -i "s/__AMI_PASSWORD__/ascn-internal/" /etc/asterisk/manager.conf
fi

exec asterisk -f -vvv
