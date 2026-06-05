// Webhook receiver helpers — GitHub-style HMAC-SHA256 signature verification
// (X-Hub-Signature-256: sha256=<hex>). The doc's "verify the signature, resolve
// repo -> service, enqueue a deploy".
import crypto from 'node:crypto';

export function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(secret, body, header) {
  if (!header) return false;
  const expected = sign(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Extract the pushed ref/commit from a GitHub-style push payload.
// Falls back to the service's default branch when fields are absent.
export function parsePush(payload, service) {
  let branch = service.branch;
  try {
    const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (obj?.ref?.startsWith('refs/heads/')) branch = obj.ref.slice('refs/heads/'.length);
    return { branch, after: obj?.after || null };
  } catch {
    return { branch, after: null };
  }
}
