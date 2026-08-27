# Записи звонков, off-site backup и проверка восстановления

## Что защищает эта схема

Новые записи после закрытия WAV загружаются в S3-совместимое object storage под
неизменяемым tenant-scoped ключом:

```text
recordings/<tenantId>/<callId>.wav
```

Локальный WAV создаётся с режимом `0600`. Он удаляется только после
подтверждённых S3 `PUT` и DB metric ACK; `OBJECT_STORAGE_KEEP_LOCAL_COPY=true`
оставляет копию для отладки. Повторная загрузка не перезаписывает существующий объект: gateway
принимает `412` только после сверки размера и SHA-256 через `HEAD`.
Одноразовый `minio-init` идемпотентно включает versioning на production bucket
и завершает запуск с ошибкой, если MinIO не подтверждает статус `Enabled`.
Versioning сохраняет предыдущую версию при случайном overwrite и оставляет
старые версии за delete marker при обычном удалении. Это дополнительный слой
восстановления, а не WORM: root/admin всё ещё может удалить конкретную версию,
а старые версии занимают место, пока их не удалит явно настроенный lifecycle.
До открытия recorder gateway фиксирует tenant/call binding в
`*.wav.upload.json`. Запись идёт в `*.wav.part`; имя `*.wav` публикуется
атомарно только после закрытия и fsync. Поэтому crash сразу после
`recorder.close()` оставляет безопасный recovery candidate: worker берёт
tenant из pre-created sidecar, проверяет RIFF/размер, вычисляет длительность
и повторяет upload. Открытый `.part` никогда не загружается.
После S3 upload sidecar остаётся до идемпотентного подтверждения
`recorded_seconds` приложением. Это закрывает окно сбоя «объект загружен, но UI
не узнал о записи»: retry worker повторяет DB metric и лишь после ACK очищает
локальный spool.

Ежедневный backup делает согласованный `pg_dump --format=custom`, выгружает
записи через S3 API в переносимом виде, строит SHA-256 manifest и передаёт всё в
restic. Restic шифрует данные до отправки и дедуплицирует повторные снимки.
До завершения одноразовой миграции он также включает старые WAV из
`/app/legacy-data/recordings`; новые звонки туда не пишутся. Отдельно в
`recording-spool/` попадают ещё не закоммиченные WAV, sidecar и `.part`:
это recovery state для сбоя между S3 upload и DB ACK.
Удалённый restic repository должен находиться у другого провайдера или как
минимум в независимом failure domain. Копия в другом bucket на том же диске
MinIO не является off-site backup.

Раз в неделю `restore-test.sh` действительно восстанавливает последний снимок,
проверяет каждый файл по SHA-256, заголовки WAV и разворачивает dump в отдельном
одноразовом контейнере PostgreSQL. Production DB и production bucket этот тест
не изменяет. После логического restore он дополнительно доказывает, что для
каждой строки `ascn_call_records` с `recorded_seconds > 0` существует
tenant-scoped S3-объект либо переходный legacy WAV.

## Переменные приложения и voice gateway

Если задана хотя бы одна из четырёх обязательных переменных object storage, но
набор неполон, приложение останавливает операцию с ошибкой — fallback при
ошибочной конфигурации не используется.

Обязательные вместе:

- `OBJECT_STORAGE_ENDPOINT` — base URL без credentials/query/fragment;
- `OBJECT_STORAGE_BUCKET` — bucket для записей;
- `OBJECT_STORAGE_ACCESS_KEY_ID`;
- `OBJECT_STORAGE_SECRET_ACCESS_KEY`.

Настройки:

- `OBJECT_STORAGE_REGION` — по умолчанию `us-east-1`;
- `OBJECT_STORAGE_FORCE_PATH_STYLE` — по умолчанию `true`, удобно для MinIO;
- `OBJECT_STORAGE_ALLOW_INSECURE_HTTP=true` — только для изолированного
  внутреннего Docker-сегмента; внешний endpoint должен быть HTTPS;
- `OBJECT_STORAGE_SESSION_TOKEN` — только для временных credentials;
- `OBJECT_STORAGE_MAX_RECORDING_BYTES` — по умолчанию `240000000`; этого
  достаточно для максимального двухчасового stereo PCM звонка (~230,4 MB);
- `OBJECT_STORAGE_REQUEST_TIMEOUT_MS` — time-to-first-byte для чтения,
  по умолчанию `15000`;
- `OBJECT_STORAGE_KEEP_LOCAL_COPY=true` — не удалять spool после upload;
- `OBJECT_STORAGE_UPLOAD_CONCURRENCY` — retry worker, по умолчанию `2`, предел
  `1..8`;
- `OBJECT_STORAGE_UPLOAD_SCAN_LIMIT` — максимум sidecar за один проход, по
  умолчанию `500`, обход ротируется и не создаёт starvation;
- `OBJECT_STORAGE_UPLOAD_RETRY_MS` — по умолчанию `60000`, предел
  `10000..3600000`;
- `OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION=AES256` либо `aws:kms`;
- `OBJECT_STORAGE_SSE_KMS_KEY_ID` — обязателен при `aws:kms`.

Приложению достаточно `s3:GetObject`; voice gateway нужны `s3:PutObject` и
`s3:GetObject`/`s3:HeadObject`. Compose автоматически включает и проверяет
versioning. App/gateway/backup users ограничены prefix `recordings/` и не имеют
`DeleteObject`; root key MinIO этим контейнерам не передаётся. Public access не
включается. Lifecycle для non-current versions и Object Lock/retention не
настраиваются автоматически: их срок зависит от юридических требований и
доступного объёма, а ошибка в WORM retention может заблокировать штатное
удаление. Настраивайте их отдельным контролируемым изменением после расчёта
ёмкости и проверки процедуры удаления.

Маршрут чтения сначала проверяет call record внутри текущего tenant context,
затем читает новый ключ. Для безопасной миграции он проверяет старый
`recordings/<callId>.wav` и локальный файл только при честном `404`; сбой S3 не
маскируется выдачей потенциально устаревшей локальной копии. Поддерживаются
HTTP Range-запросы, поэтому браузер не загружает длинную запись целиком.

## Требования к backup host

Установите на production host:

- `restic`;
- AWS CLI v2;
- Docker с Compose plugin;
- PostgreSQL client (`pg_restore` той же major-версии, что production, или
  новее);
- стандартные GNU `coreutils`, `findutils`, `util-linux`, `openssl`.

Создайте отдельные credentials:

1. read-only ключ с `ListBucket`/`GetObject` к primary bucket записей;
2. отдельный write/read ключ к off-site restic bucket;
3. случайный пароль restic, который не хранится в репозитории и сохраняется ещё
   в одном защищённом password manager. Без него backup восстановить нельзя.

Пример конфигурации находится в `ops/backup.env.example`. Установите файлы так:

```bash
sudo install -d -m 0700 /etc/ascn /var/lib/ascn-backup
sudo install -m 0600 ops/backup.env.example /etc/ascn/backup.env
openssl rand -base64 48 | sudo tee /etc/ascn/restic-password >/dev/null
sudo chmod 0600 /etc/ascn/restic-password
sudo chown root:root /etc/ascn/backup.env /etc/ascn/restic-password
```

Замените все `REPLACE_ME`. Значение
`BACKUP_OFFSITE_CONFIRMED=YES_I_HAVE_VERIFIED` — явное подтверждение, что
repository переживёт полную потерю production host и primary object storage.
Скрипт принимает только `s3:` restic repository и fail-closed при отсутствующем
секрете, небезопасных правах файлов или неинициализированном repository.

Файл `/etc/ascn/backup.env` является доверенным root-owned shell environment
file: не помещайте туда команды и не давайте к нему права записи другим
пользователям.

## Однократная инициализация

Сначала загрузите и зафиксируйте restore image. Его major должен совпадать с
production PostgreSQL или быть новее; digest предпочтительнее mutable tag:

```bash
sudo docker pull postgres:17.11-alpine
sudo docker image inspect postgres:17.11-alpine --format '{{index .RepoDigests 0}}'
```

После заполнения `/etc/ascn/backup.env` и сохранения пароля инициализируйте
repository ровно один раз. `backup.sh` намеренно не делает `restic init`: при
сетевой или credential-ошибке он не должен случайно создать новый пустой
repository.

```bash
sudo bash -c '
  set -a
  source /etc/ascn/backup.env
  set +a
  AWS_ACCESS_KEY_ID="$RESTIC_S3_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$RESTIC_S3_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="${RESTIC_S3_REGION:-us-east-1}" \
  restic init
'
```

Запустите первый backup и полный restore test вручную:

```bash
sudo BACKUP_ENV_FILE=/etc/ascn/backup.env /opt/ascn-voice/scripts/backup.sh
sudo BACKUP_ENV_FILE=/etc/ascn/backup.env /opt/ascn-voice/scripts/restore-test.sh
```

Оба вызова должны завершиться кодом `0`. Наличие snapshot без успешного
restore-test не считается проверенным backup.

## Ежедневный timer и алертинг

```bash
sudo install -m 0644 ops/systemd/ascn-backup.service ops/systemd/ascn-backup.timer \
  ops/systemd/ascn-restore-test.service ops/systemd/ascn-restore-test.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ascn-backup.timer ascn-restore-test.timer
systemctl list-timers 'ascn-*'
```

Backup запускается ежедневно примерно в `03:17`, restore test — по воскресеньям
примерно в `05:20`; оба timer имеют случайную задержку до 30 минут и
`Persistent=true`. Логи:

```bash
journalctl -u ascn-backup.service -u ascn-restore-test.service --since '7 days ago'
```

Systemd сам по себе не отправляет уведомления. В production мониторинге нужен
алерт на failed unit и на возраст последнего snapshot более 26 часов. Проверка
возвратного кода важнее поиска строки в логе: скрипты публикуют success только
после завершения restic и всех проверок.

## Retention и стоимость

По умолчанию сохраняются 7 daily, 5 weekly и 12 monthly snapshots. Ежедневный
`prune` выключен, потому что для большого удалённого repository он дорогой;
запускайте prune отдельным ежемесячным maintenance job или задайте
`BACKUP_PRUNE_AFTER_FORGET=true`. `restic check` ежедневно читает случайные 5%
pack-файлов; `BACKUP_RESTIC_CHECK_SUBSET=off` отключает это только при наличии
другого integrity monitor.

S3 export сейчас полный: каждый день заново читается только текущая версия
каждого объекта с primary storage; non-current версии MinIO в portable export
не входят. Restic отправляет только новые chunks. Это простая переносимая
стратегия для текущего объёма. Versioning на primary bucket уже включается
автоматически, но не заменяет backup: для защиты всего history от потери MinIO
нужна отдельно настроенная cross-provider replication версий либо специальный
экспорт версий. При росте добавьте такую репликацию, сохранив периодический
portable export и restore drill.

Порядок операций даёт практическую согласованность без остановки звонков:
gateway сначала подтверждает S3 upload и только затем выставляет
`recorded_seconds`; backup сначала снимает PostgreSQL snapshot, затем читает
immutable objects. Поэтому DB snapshot не может ссылаться на ещё не загруженный
новый объект. Объект звонка, закончившегося после начала `pg_dump`, может стать
безопасным лишним объектом и будет связан со строкой в следующем daily backup.
Удаление записей во время backup запрещается; включённый versioning помогает
восстановить предыдущую версию, но ежедневный export фиксирует только latest.

## Аварийное восстановление

1. Зафиксируйте выбранный snapshot и остановите writers.
2. Восстановите snapshot в новый пустой каталог, не поверх production данных.
3. Создайте новую пустую PostgreSQL database и выполните `pg_restore
   --exit-on-error --no-owner --no-privileges`.
4. Верните каталог `object-storage/` через `aws s3 sync` в новый пустой bucket
   под prefix из `METADATA`.
5. Верните `recording-spool/` в пустой persistent volume gateway до его
   запуска: retry worker безопасно доставит остаток.
6. Сверьте `SHA256SUMS`, количество таблиц и объектов, затем переключите
   приложение на новые DB/bucket credentials.
6. Сохраните старые DB и bucket read-only до завершения бизнес-проверки.

Не выполняйте restore поверх живой базы или непустого bucket: это отдельная
операция с явным окном обслуживания и планом отката.
