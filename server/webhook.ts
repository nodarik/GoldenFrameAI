import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";

// A public deploy must not post into its own network: loopback, private, link-local, CGNAT and Fly's private IPv6.
const internal = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const)
  internal.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10]] as const)
  internal.addSubnet(net, prefix, "ipv6");

// Outside the production image (the Dockerfile sets NODE_ENV) posting to localhost is the point.
const local = () => process.env.NODE_ENV !== "production";

/** Why a webhook URL can't be used, or null when it can. */
export function webhookProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a valid URL.";
  }
  if (url.protocol === "https:" || (local() && url.protocol === "http:")) return null;
  return "The webhook URL must start with https://.";
}

/**
 * POST a JSON event once, signed like GitHub/Stripe webhooks: X-TrueScene-Signature is
 * "sha256=" + hex HMAC-SHA256 of the raw body with the scene's webhook secret.
 * Failures are only logged; the receiver can still fetch the result from the API.
 */
export async function deliver(raw: string, secret: string, payload: unknown) {
  try {
    const url = new URL(raw);
    if (!local()) {
      const addrs = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
      if (addrs.some((a) => internal.check(a.address, a.family === 6 ? "ipv6" : "ipv4")))
        return console.warn(`Webhook skipped: ${url.host} resolves to a private address.`);
    }
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-truescene-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` },
    });
    if (!res.ok) console.warn(`Webhook to ${url.host} answered ${res.status}.`);
  } catch (e) {
    console.warn(`Webhook to ${raw} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
