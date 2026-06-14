# The bex infra (management) cluster base on Hetzner: SSH key + private network +
# firewall + ONE small node running single-node k3s. CAPH gets installed on top of
# this k3s afterwards (clusterctl init — a k8s-level step, see README phase 2), and
# CAPH then provisions the app cluster. This file is just the day-0 substrate.

# SSH key — single source of truth. The CAPH overlay references it by NAME
# (sshKeys.hcloud.name = var.ssh_key_name), so app-cluster nodes reuse the same key.
resource "hcloud_ssh_key" "bex" {
  name       = var.ssh_key_name
  public_key = var.ssh_public_key
}

# Private network shared by the infra cluster and (later) the app-cluster nodes.
resource "hcloud_network" "bex" {
  name     = "bex"
  ip_range = var.network_cidr
}

resource "hcloud_network_subnet" "bex" {
  network_id   = hcloud_network.bex.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = var.subnet_cidr
}

# Firewall for the infra node: SSH + k3s API from allowed CIDRs, ICMP for diag.
resource "hcloud_firewall" "infra" {
  name = "bex-infra"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.allowed_ssh_cidrs
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "6443" # k3s / kube API
    source_ips = var.allowed_ssh_cidrs
  }

  rule {
    direction  = "in"
    protocol   = "icmp"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

# The infra (management) cluster: a single small node running single-node k3s.
# cloud-init installs k3s; CAPH is layered on later via clusterctl (README phase 2).
resource "hcloud_server" "infra" {
  name        = "bex-infra"
  server_type = var.infra_server_type
  image       = var.image
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.bex.id]

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    k3s_channel = var.k3s_channel
  })

  network {
    network_id = hcloud_network.bex.id
  }

  labels = {
    role = "infra-cluster"
    bex  = "true"
  }

  depends_on = [hcloud_network_subnet.bex]
}

resource "hcloud_firewall_attachment" "infra" {
  firewall_id = hcloud_firewall.infra.id
  server_ids  = [hcloud_server.infra.id]
}
