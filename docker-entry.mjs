const requiredValues = [
  "DATABASE_URL",
  "REDIS_URL",
  "ADMIN_PASSWORD",
  "GATEWAY_APP_KEY",
  "APP_GATEWAY_KEY",
  "BROWSER_TOKEN_SECRET",
  "EXTERNAL_CALL_API_KEY",
  "VOICE_GATEWAY_INTERNAL_URL",
  "OBJECT_STORAGE_ENDPOINT",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_ACCESS_KEY_ID",
  "OBJECT_STORAGE_SECRET_ACCESS_KEY",
];

for (const name of requiredValues) {
  if (!process.env[name]?.trim()) throw new Error(`${name} must be configured`);
}

const independentKeys = ["GATEWAY_APP_KEY", "APP_GATEWAY_KEY", "BROWSER_TOKEN_SECRET", "EXTERNAL_CALL_API_KEY"];
const values = independentKeys.map((name) => process.env[name].trim());
for (const [index, value] of values.entries()) {
  if (Buffer.byteLength(value) < 32) throw new Error(`${independentKeys[index]} must contain at least 32 bytes`);
}
if (new Set(values).size !== values.length) throw new Error("Internal keys must all be different");
if (Buffer.byteLength(process.env.ADMIN_PASSWORD.trim()) < 16) {
  throw new Error("ADMIN_PASSWORD must contain at least 16 bytes");
}

await import("./server.js");
