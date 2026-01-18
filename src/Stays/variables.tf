variable "region" {
  default = "us-east-1"
}

variable "db_username" {
  default = "user"
}

variable "db_password" {
  description = "Database password"
  sensitive   = true
}

variable "api_key" {
  description = "API Key for the Enterprise Mapping Service"
  sensitive   = true
}

variable "ecr_repository_url" {
  description = "URL of the ECR repository containing the Docker image"
}