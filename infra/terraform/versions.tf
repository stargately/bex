terraform {
  required_version = ">= 1.10" # use_lockfile (S3-native state locking) needs 1.10+

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }

  # Remote state in Hetzner Object Storage (S3-compatible). This is NOT a one-shot
  # script: state lives remotely, so `apply` is idempotent and CI re-runs converge
  # (plan on PR, apply on merge, scheduled plan = drift detection).
  #
  # The state bucket is the one irreducible "bottom turtle" — create it ONCE,
  # out-of-band, before the first `terraform init` (see README).
  #
  # Dynamic values come from CI via `-backend-config` (so the same code serves
  # staging/prod); only the non-AWS S3 quirks are pinned here.
  backend "s3" {
    use_path_style              = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_s3_checksum            = true
    use_lockfile                = true # S3-native lock (a .tflock object); no DynamoDB needed
  }
}

provider "hcloud" {
  token = var.hcloud_token
}
