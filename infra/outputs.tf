output "service_url" {
  value       = google_cloud_run_v2_service.council_mcp.uri
  description = "Cloud Run service URL."
}

output "mcp_url" {
  value       = "${google_cloud_run_v2_service.council_mcp.uri}/mcp"
  description = "MCP endpoint — add this as the custom-connector URL in claude.ai."
}
