// Short, human-readable, prefixed ids in the style of the strategy doc
// (svc_3f9a2, dep_002, bld_77, rev_5, whsec_...).
import crypto from 'node:crypto';

function rand(n) {
  return crypto.randomBytes(n).toString('hex').slice(0, n);
}

export const newServiceId = () => `svc_${rand(5)}`;
export const newDeployId = () => `dep_${rand(4)}`;
export const newBuildId = () => `bld_${rand(4)}`;
export const newWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('hex')}`;
