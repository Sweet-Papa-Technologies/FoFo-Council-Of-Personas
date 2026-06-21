variable "project_id" {
  type        = string
  description = "GCP project ID (e.g. fofoapps-934be)."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Cloud Run / Artifact Registry region."
}

variable "council_model" {
  type        = string
  default     = "gemini-3.5-flash"
  description = "Default council-member model (COUNCIL_MODEL)."
}

variable "image" {
  type        = string
  default     = null
  description = "Container image. Defaults to <region>-docker.pkg.dev/<project>/council/council-mcp:latest (shipped by Cloud Build)."
}

variable "github_owner" {
  type        = string
  default     = ""
  description = "GitHub owner for the Cloud Build trigger (e.g. Sweet-Papa-Technologies). Empty = no trigger. Requires the Cloud Build GitHub App connected to the repo."
}

variable "github_repo" {
  type        = string
  default     = "FoFo-Council-Of-Personas"
  description = "GitHub repo name for the Cloud Build trigger."
}
