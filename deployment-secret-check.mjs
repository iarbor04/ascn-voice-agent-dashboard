function value(name, minimum = 32) {
  const result = process.env[name]?.trim() || "";
  if (Buffer.byteLength(result) < minimum) throw new Error(`${name} must contain at least ${minimum} bytes`);
  return result;
}

function distinct(names, minimum = 32) {
  const values = names.map((name) => value(name, minimum));
  if (new Set(values).size !== values.length) throw new Error(`${names.join(", ")} must all be different`);
  return values;
}

distinct(["GATEWAY_APP_KEY", "APP_GATEWAY_KEY", "BROWSER_TOKEN_SECRET", "EXTERNAL_CALL_API_KEY", "AMI_PASSWORD"]);
distinct(["POSTGRES_SUPERUSER_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD", "POSTGRES_RUNTIME_PASSWORD", "POSTGRES_BACKUP_PASSWORD"]);
distinct(["REDIS_ADMIN_PASSWORD", "REDIS_APP_PASSWORD", "REDIS_GATEWAY_PASSWORD"]);
distinct([
  "MINIO_ROOT_PASSWORD",
  "OBJECT_STORAGE_APP_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_GATEWAY_SECRET_ACCESS_KEY",
  "OBJECT_STORAGE_BACKUP_SECRET_ACCESS_KEY",
]);
distinct([
  "MINIO_ROOT_USER",
  "OBJECT_STORAGE_APP_ACCESS_KEY_ID",
  "OBJECT_STORAGE_GATEWAY_ACCESS_KEY_ID",
  "OBJECT_STORAGE_BACKUP_ACCESS_KEY_ID",
], 12);
value("ADMIN_PASSWORD", 16);

const objectStorageBucket = process.env.OBJECT_STORAGE_BUCKET?.trim() || "ascn-recordings";
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(objectStorageBucket)
  || objectStorageBucket.includes("..")
  || /^\d+\.\d+\.\d+\.\d+$/.test(objectStorageBucket)) {
  throw new Error("OBJECT_STORAGE_BUCKET is not a valid DNS-style bucket name");
}

for (const name of ["POSTGRES_SUPERUSER_PASSWORD", "POSTGRES_MIGRATOR_PASSWORD", "POSTGRES_RUNTIME_PASSWORD", "POSTGRES_BACKUP_PASSWORD", "REDIS_ADMIN_PASSWORD", "REDIS_APP_PASSWORD", "REDIS_GATEWAY_PASSWORD", "AMI_PASSWORD"]) {
  if (!/^[a-zA-Z0-9._~-]+$/.test(process.env[name] || "")) throw new Error(`${name} contains characters unsafe for the generated runtime configuration`);
}

console.log("Deployment secret separation validated");
