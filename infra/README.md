# Infrastructure (Terraform + Cloud Build)

Codifies the Cloud Run MCP backend in project **`fofoapps-934be`**: APIs, Artifact
Registry, Secret Manager (containers + IAM), the Cloud Run service (env + secret
wiring), public invoker, and a Cloud Build trigger that builds + deploys on push.

> The backend was first stood up imperatively (gcloud) and is **live**. This Terraform
> describes that same desired state. To make Terraform the source of truth, **import**
> the existing resources once (below), then `terraform apply`.

## Secret values (never in git)

Terraform manages the secret *containers* and access; you add the *values*:

```bash
P=fofoapps-934be
printf '%s' "<GEMINI_API_KEY>"      | gcloud secrets versions add council-gemini-key       --data-file=- --project $P
printf '%s' "$(openssl rand -hex 24)" | gcloud secrets versions add council-mcp-token        --data-file=- --project $P
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets versions add council-oauth-secret     --data-file=- --project $P
printf '%s' "<consent-passphrase>"   | gcloud secrets versions add council-oauth-passphrase --data-file=- --project $P
```

(These already exist on the live project; values are also mirrored in the macOS
Keychain under service `council-of-personas`.)

## First-time apply on a fresh project

```bash
cd infra
terraform init
terraform apply -var project_id=fofoapps-934be -var github_owner=Sweet-Papa-Technologies
# Then ship an image:
gcloud builds submit --config ../cloudbuild.yaml --project fofoapps-934be
terraform output mcp_url
```

## Adopt the already-running resources (import)

```bash
cd infra
terraform init
P=fofoapps-934be; R=us-central1
terraform import -var project_id=$P google_artifact_registry_repository.council projects/$P/locations/$R/repositories/council
for s in council-gemini-key council-mcp-token council-oauth-secret council-oauth-passphrase; do
  terraform import -var project_id=$P "google_secret_manager_secret.s[\"$s\"]" projects/$P/secrets/$s
done
terraform import -var project_id=$P google_cloud_run_v2_service.council_mcp projects/$P/locations/$R/services/council-mcp
terraform plan -var project_id=$P    # review; then apply
```

## CI/CD (Cloud Build trigger)

The `google_cloudbuild_trigger.deploy` resource (enabled when `github_owner` is set)
runs `cloudbuild.yaml` on push to `main` — build image → push to Artifact Registry →
`gcloud run deploy --image`. It requires the **Cloud Build GitHub App** to be connected
to the repo once (Console → Cloud Build → Triggers → Connect repository). Until then,
deploy manually with `gcloud builds submit --config cloudbuild.yaml` or
`gcloud run deploy council-mcp --source .`.
