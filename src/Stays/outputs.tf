output "load_balancer_dns" {
  value = aws_lb.main.dns_name
}

output "db_endpoint" {
  value = aws_db_instance.postgres.address
}