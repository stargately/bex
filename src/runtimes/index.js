// Runtime selector. The runtime is the "node plane" — what a service revision
// actually runs on. Chosen by config.runtime (BEX_RUNTIME): 'docker' or
// 'opensandbox'. Both expose the same interface:
//   start({image,port,env,revision,serviceId}) -> { handle, target:{host,port,prefix} }
//   pause(handle)
//   resume(handle, port) -> { target }
//   remove(handle)
//   removeAllForService(serviceId)
import { config } from '../config.js';
import * as docker from './docker.js';
import * as opensandbox from './opensandbox.js';
import * as opensandboxK8s from './opensandbox-k8s.js';

const runtimes = { docker, opensandbox, 'opensandbox-k8s': opensandboxK8s };

export function runtime() {
  const rt = runtimes[config.runtime];
  if (!rt) throw new Error(`unknown BEX_RUNTIME: ${config.runtime} (use docker|opensandbox)`);
  return rt;
}
