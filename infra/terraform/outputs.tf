output "infra_server_ipv4" {
  description = "Public IPv4 of the infra (management) cluster node."
  value       = hcloud_server.infra.ipv4_address
}

output "network_id" {
  description = "Private network id — app-cluster nodes (CAPH) join this."
  value       = hcloud_network.bex.id
}

output "ssh_key_name" {
  description = "The hcloud SSH key name (CAPH overlay must reference the same)."
  value       = hcloud_ssh_key.bex.name
}

output "fetch_kubeconfig" {
  description = "One-liner to pull the infra cluster kubeconfig (run from CI, not a laptop)."
  value       = "ssh root@${hcloud_server.infra.ipv4_address} 'cat /etc/rancher/k3s/k3s.yaml' | sed 's#https://127.0.0.1:6443#https://${hcloud_server.infra.ipv4_address}:6443#' > infra.kubeconfig"
}
