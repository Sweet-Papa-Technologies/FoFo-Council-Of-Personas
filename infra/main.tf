# Council of Personas — backend infrastructure (Cloud Run MCP server).
# Manages: APIs, Artifact Registry, Secret Manager (containers + access),
# the Cloud Run service (env + secret wiring), public invoker, and a Cloud
# Build trigger that builds + deploys on push to main.
#
# The container IMAGE is shipped by Cloud Build (cloudbuild.yaml); Terraform
# owns everything else and ignores image drift. See infra/README.md.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "p" {}

locals {
  run_sa   = "${data.google_project.p.number}-compute@developer.gserviceaccount.com"
  build_sa = "${data.google_project.p.number}@cloudbuild.gserviceaccount.com"
  image    = coalesce(var.image, "${var.region}-docker.pkg.dev/${var.project_id}/council/council-mcp:latest")

  apis = [
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "generativelanguage.googleapis.com",
  ]

  # Secret containers TF manages. Values are added out-of-band (never in git) —
  # see infra/README.md.
  secrets = [
    "council-gemini-key",
    "council-mcp-token",
    "council-oauth-secret",
    "council-oauth-passphrase",
  ]

  # env var name -> secret id
  secret_env = {
    LITELLM_API_KEY   = "council-gemini-key"
    MCP_BEARER_TOKEN  = "council-mcp-token"
    OAUTH_HMAC_SECRET = "council-oauth-secret"
    OAUTH_PASSPHRASE  = "council-oauth-passphrase"
  }
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "council" {
  location      = var.region
  repository_id = "council"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_secret_manager_secret" "s" {
  for_each  = toset(local.secrets)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "run_access" {
  for_each  = google_secret_manager_secret.s
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.run_sa}"
}

resource "google_cloud_run_v2_service" "council_mcp" {
  name                = "council-mcp"
  location            = var.region
  deletion_protection = false

  template {
    timeout = "300s"
    containers {
      image = local.image
      ports { container_port = 8080 }
      resources { limits = { memory = "512Mi" } }

      env {
        name  = "MCP_HTTP"
        value = "1"
      }
      env {
        name  = "LITELLM_BASE_URL"
        value = "https://generativelanguage.googleapis.com/v1beta/openai"
      }
      env {
        name  = "COUNCIL_MODEL"
        value = var.council_model
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  # Cloud Build ships new images under the same tag; don't fight it.
  lifecycle { ignore_changes = [template[0].containers[0].image] }

  depends_on = [google_secret_manager_secret_iam_member.run_access]
}

# Public at the IAM layer — the app itself gates with the bearer token / OAuth.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.council_mcp.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Let Cloud Build deploy to Cloud Run.
resource "google_project_iam_member" "build_run" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${local.build_sa}"
}
resource "google_project_iam_member" "build_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${local.build_sa}"
}

# CI: build + deploy on push to main (only when a GitHub repo is configured).
resource "google_cloudbuild_trigger" "deploy" {
  count    = var.github_owner == "" ? 0 : 1
  name     = "council-mcp-deploy"
  filename = "cloudbuild.yaml"
  github {
    owner = var.github_owner
    name  = var.github_repo
    push { branch = "^main$" }
  }
  substitutions = { _REGION = var.region }
  depends_on    = [google_project_service.apis]
}
