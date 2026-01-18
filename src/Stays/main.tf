provider "aws" {
  region = var.region
}

# --- Networking (VPC) ---
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"

  name = "hotel-mapping-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.region}a", "${var.region}b"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true
}

# --- Security Groups ---
resource "aws_security_group" "lb_sg" {
  name        = "hotel-mapping-lb-sg"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs_sg" {
  name        = "hotel-mapping-ecs-sg"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.lb_sg.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds_sg" {
  name        = "hotel-mapping-rds-sg"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_sg.id]
  }
}

# --- Database (RDS Postgres) ---
resource "aws_db_instance" "postgres" {
  identifier             = "hotel-mapping-db"
  engine                 = "postgres"
  engine_version         = "14"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  db_name                = "hotel_mapping"
  username               = var.db_username
  password               = var.db_password
  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  db_subnet_group_name   = module.vpc.database_subnet_group_name
  skip_final_snapshot    = true
  publicly_accessible    = false
}

# --- ECS Cluster ---
resource "aws_ecs_cluster" "main" {
  name = "hotel-mapping-cluster"
}

# --- IAM Roles ---
resource "aws_iam_role" "ecs_task_execution_role" {
  name = "ecsTaskExecutionRole"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_role_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --- Load Balancer ---
resource "aws_lb" "main" {
  name               = "hotel-mapping-lb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.lb_sg.id]
  subnets            = module.vpc.public_subnets
}

resource "aws_lb_target_group" "api" {
  name        = "hotel-mapping-api-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"
  health_check {
    path = "/health"
  }
}

resource "aws_lb_listener" "front_end" {
  load_balancer_arn = aws_lb.main.arn
  port              = "80"
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# --- ECS Task Definition (API) ---
resource "aws_ecs_task_definition" "api" {
  family                   = "hotel-mapping-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_task_execution_role.arn

  container_definitions = jsonencode([{
    name  = "api"
    image = "${var.ecr_repository_url}:latest" # You must build/push your Docker image to ECR
    portMappings = [{ containerPort = 3000, hostPort = 3000 }]
    environment = [
      { name = "DATABASE_URL", value = "postgresql://${var.db_username}:${var.db_password}@${aws_db_instance.postgres.address}:5432/hotel_mapping" },
      { name = "ENTERPRISE_API_KEY", value = var.api_key },
      { name = "PORT", value = "3000" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/hotel-mapping-api"
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

# --- ECS Service (API) ---
resource "aws_ecs_service" "api" {
  name            = "hotel-mapping-api-service"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.ecs_sg.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
}

# --- CloudWatch Logs ---
resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "/ecs/hotel-mapping-api"
  retention_in_days = 7
}