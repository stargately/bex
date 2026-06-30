# infra/local — local bootstrap (kind infra cluster + CAPD + KWOK)

Stands up the local mock of the Hetzner substrate, entirely in Docker:

- a **kind** cluster as the **infra cluster** (Cluster API's management cluster);
- **CAPD** (Cluster API Docker provider) so "machines" are Docker-container nodes;
- a CAPD **app cluster** (`infra/clusterapi/overlays/local-capd`) where bex runs;
- (optional) **KWOK** for testing the allocator against many fake nodes cheaply.

Run `scripts/mock-cluster.sh` to bring it up. Add/remove a machine = `kubectl scale machinedeployment ... --replicas=N` against the infra cluster. Swap CAPD → CAPH (`infra/clusterapi/overlays/hetzner-caph`) for Hetzner; bex unchanged.
