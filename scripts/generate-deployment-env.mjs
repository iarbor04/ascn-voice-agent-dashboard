import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const outputPath = path.resolve(process.argv[2] || ".env");
const externalIp = String(process.argv[3] || "").trim();
const hostPort = Number(process.argv[4] || 3100);

if (net.isIP(externalIp) !== 4) {
  throw new Error("Usage: node scripts/generate-deployment-env.mjs OUTPUT_PATH EXTERNAL_IPV4 [HOST_PORT]");
}
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("Invalid host port");

const secret = () => randomBytes(32).toString("hex");
const identifier = (prefix) => `${prefix}-${randomBytes(8).toString("hex")}`;
const adminPassword = randomBytes(24).toString("base64url");

const values = {
  ASCN_BIND_ADDRESS: "127.0.0.1",
  ASCN_HOST_PORT: String(hostPort),
  ASCN_VOICE_GATEWAY_PORT: "8787",
  ASCN_OBJECT_STORAGE_PORT: "9000",
  ASCN_SIP_PORT: "5060",
  ASTERISK_EXTERNAL_IP: externalIp,
  ADMIN_USERNAME: "admin@ascn.local",
  ADMIN_PASSWORD: adminPassword,
  GATEWAY_APP_KEY: secret(),
  APP_GATEWAY_KEY: secret(),
  BROWSER_TOKEN_SECRET: secret(),
  EXTERNAL_CALL_API_KEY: secret(),
  AMI_PASSWORD: secret(),
  POSTGRES_SUPERUSER_PASSWORD: secret(),
  POSTGRES_MIGRATOR_PASSWORD: secret(),
  POSTGRES_RUNTIME_PASSWORD: secret(),
  POSTGRES_BACKUP_PASSWORD: secret(),
  REDIS_ADMIN_PASSWORD: secret(),
  REDIS_APP_PASSWORD: secret(),
  REDIS_GATEWAY_PASSWORD: secret(),
  MINIO_ROOT_USER: identifier("ascn-root"),
  MINIO_ROOT_PASSWORD: secret(),
  OBJECT_STORAGE_APP_ACCESS_KEY_ID: identifier("ascn-app"),
  OBJECT_STORAGE_APP_SECRET_ACCESS_KEY: secret(),
  OBJECT_STORAGE_GATEWAY_ACCESS_KEY_ID: identifier("ascn-gateway"),
  OBJECT_STORAGE_GATEWAY_SECRET_ACCESS_KEY: secret(),
  OBJECT_STORAGE_BACKUP_ACCESS_KEY_ID: identifier("ascn-backup"),
  OBJECT_STORAGE_BACKUP_SECRET_ACCESS_KEY: secret(),
  OBJECT_STORAGE_REGION: "us-east-1",
  OBJECT_STORAGE_BUCKET: "ascn-recordings",
  TRUST_PROXY: "false",
  ALLOW_PUBLIC_REGISTRATION: "false",
  DIRECT_SIP_RESERVATIONS: "{}",
  MAX_BROWSER_SESSIONS: "5",
  MAX_ACTIVE_CALLS: "30",
};

const contents = `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
await writeFile(outputPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ outputPath, adminUsername: values.ADMIN_USERNAME, adminPassword }));
