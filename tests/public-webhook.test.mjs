import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isUnsafeAddress, postPublicWebhook } from "../voice-gateway/public-webhook.mjs";

test("custom webhooks reject non-public IPv4 and IPv6 destinations", async () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "ff02::1",
  ]) assert.equal(isUnsafeAddress(address), true, `${address} must be blocked`);

  assert.equal(isUnsafeAddress("8.8.8.8"), false);
  assert.equal(isUnsafeAddress("2606:4700:4700::1111"), false);

  await assert.rejects(
    postPublicWebhook("http://example.com/hook", { payload: {} }),
    /credential-free HTTPS URL/,
  );
  await assert.rejects(
    postPublicWebhook("https://127.0.0.1/hook", { payload: {} }),
    /non-public address/,
  );
  await assert.rejects(
    postPublicWebhook("https://[::1]/hook", { payload: {} }),
    /non-public address/,
  );
  await assert.rejects(
    postPublicWebhook("https://user:password@example.com/hook", { payload: {} }),
    /credential-free HTTPS URL/,
  );
});

test("gateway routes tenant webhooks through the pinned public client", async () => {
  const gateway = await readFile(new URL("../voice-gateway/server.mjs", import.meta.url), "utf8");
  assert.match(gateway, /import \{ postPublicWebhook \} from "\.\/public-webhook\.mjs"/);
  assert.match(gateway, /return postPublicWebhook\(custom\.webhookUrl,/);
  assert.doesNotMatch(gateway, /fetch\(custom\.webhookUrl/);
});
