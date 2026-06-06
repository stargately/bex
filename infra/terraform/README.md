# infra/terraform — base IaC substrate [seam]

Provisions the **base** for Hetzner: the infra cluster host(s), private
network, load balancer, firewall, and bootstrap. One-shot declarative IaC (not
reactive autoscaling — that's Cluster Autoscaler / CAPH).

Not needed locally (the local mock uses a `kind` infra cluster via
`infra/local/`). Layout when materialized:
```
terraform/
├── modules/            network / cluster / bootstrap
└── overlays/{staging,prod}/   (or TF workspaces)
```
Pairs with the popular `terraform-hcloud-kube-hetzner` module as a pragmatic option.
