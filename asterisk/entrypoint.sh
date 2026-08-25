#!/bin/sh
set -e
if [ -n "$ASTERISK_EXTERNAL_IP" ]; then
  sed -i "s/__EXTERNAL_IP__/$ASTERISK_EXTERNAL_IP/g" /etc/asterisk/pjsip.conf
  echo "ASCN: внешний адрес для SDP — $ASTERISK_EXTERNAL_IP"
else
  sed -i '/__EXTERNAL_IP__/d' /etc/asterisk/pjsip.conf
  echo "ASCN: ASTERISK_EXTERNAL_IP не задан — Asterisk будет ставить в SDP свой адрес контейнера, за NAT это даст тишину в трубке"
fi
# Без отдельного AMI-секрета контейнер не запускается. Ограниченный алфавит
# не даёт значению превратиться в часть manager.conf или sed-команды.
if [ -z "${AMI_PASSWORD:-}" ]; then
  echo "ASCN: AMI_PASSWORD обязателен" >&2
  exit 1
fi
if [ "${#AMI_PASSWORD}" -lt 32 ]; then
  echo "ASCN: AMI_PASSWORD должен содержать минимум 32 символа" >&2
  exit 1
fi
case "$AMI_PASSWORD" in
  *[!a-zA-Z0-9._~-]*)
    echo "ASCN: AMI_PASSWORD содержит недопустимые символы" >&2
    exit 1
    ;;
esac
sed -i "s/__AMI_PASSWORD__/${AMI_PASSWORD}/" /etc/asterisk/manager.conf

exec asterisk -f -vvv
