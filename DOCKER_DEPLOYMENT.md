# Docker Deployment Guide for CloudPrepper API

## Configuration Updates Made

The Docker configuration has been updated to resolve port conflicts and include necessary environment variables. The Dockerfile now exposes port 32638 to match the compose.yaml configuration, and the compose.yaml has been enhanced to include the ANTHROPIC_API_KEY and JWT_SECRET environment variables required for the question generation endpoint.

## Environment Variables Required

Your .env file should contain the following variables for Docker deployment:

```env
# Database Configuration
DB_USER=postgres
DB_PASSWORD=your-secure-password-here
DB_HOST=db
DB_PORT=5432

# Anthropic API Configuration
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# Server Configuration
PORT=32638
NODE_ENV=production
```

Ensure your .env file in C:\Projects\cloud_prepper_api contains these values before proceeding with Docker deployment.

## Option 1: Full Stack with Docker Compose (Recommended)

This approach runs both the API server and PostgreSQL database in containers, providing a complete isolated environment.

### Build and Start Services

```bash
cd C:\Projects\cloud_prepper_api
docker-compose up --build
```

This command builds the Docker image and starts both the API server and PostgreSQL database. The API will be accessible at http://localhost:32638.

### Run in Detached Mode

To run the services in the background without blocking your terminal:

```bash
docker-compose up -d --build
```

### View Logs

When running in detached mode, you can view the logs with:

```bash
docker-compose logs -f server
```

Press Ctrl+C to stop following the logs without stopping the container.

### Stop Services

To stop the running containers:

```bash
docker-compose down
```

To stop and remove all data (including database volumes):

```bash
docker-compose down -v
```

## Option 2: Standalone API Container

If you prefer to run only the API container and use an external database, you can build and run the container directly.

### Build the Image

```bash
cd C:\Projects\cloud_prepper_api
docker build -t cloudprepper-api:latest .
```

### Run the Container

```bash
docker run -d \
  --name cloudprepper-api \
  -p 32638:32638 \
  --env-file .env \
  -e DB_HOST=host.docker.internal \
  cloudprepper-api:latest
```

The flag `DB_HOST=host.docker.internal` allows the container to connect to PostgreSQL running on your host machine. For Windows and Mac, Docker provides this special DNS name automatically.

### View Container Logs

```bash
docker logs -f cloudprepper-api
```

### Stop and Remove Container

```bash
docker stop cloudprepper-api
docker rm cloudprepper-api
```

## Sending API Requests to Docker Container

Once your Docker container is running, you can send requests to the API at http://localhost:32638. The endpoint structure remains the same as when running locally.

### Testing Question Generation

First, create a test user and obtain a JWT token:

```bash
# Register a user
curl -X POST http://localhost:32638/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"test-user\",\"email\":\"test@example.com\",\"password\":\"Test123!\"}"

# Login to get JWT token
curl -X POST http://localhost:32638/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"test-user\",\"password\":\"Test123!\"}"
```

Copy the token from the login response, then use it to generate questions:

```bash
curl -X POST http://localhost:32638/questions/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -d "{\"certification_type\":\"CV0-004\",\"domain_name\":\"Cloud Architecture and Design\",\"cognitive_level\":\"Application\",\"skill_level\":\"Intermediate\",\"count\":2}"
```

## Accessing Swagger Documentation

The Swagger API documentation is available when the container is running at:

http://localhost:32638/api-docs

This provides an interactive interface for testing all API endpoints directly from your browser.

## Troubleshooting

### Port Already in Use

If you encounter an error indicating port 32638 is already in use, you can either stop the conflicting service or modify the port mapping in compose.yaml:

```yaml
ports:
  - 3000:32638  # Maps host port 3000 to container port 32638
```

### Database Connection Issues

If the API cannot connect to the database when using Docker Compose, verify that the database container is healthy:

```bash
docker-compose ps
```

The database container should show as "healthy" in the status column. If it shows as unhealthy, check the database logs:

```bash
docker-compose logs db
```

### Missing Environment Variables

If you see errors about missing environment variables, ensure your .env file contains all required variables and is in the correct location (C:\Projects\cloud_prepper_api\.env).

## Health Checks

You can verify the API is running correctly by accessing the health endpoint:

```bash
curl http://localhost:32638/api-docs
```

This should return the Swagger documentation page if the server is running properly.

## Production Deployment Considerations

For production deployment, consider the following enhancements:

The current configuration uses npm run dev which includes nodemon for hot-reloading. For production, modify the Dockerfile CMD to use a production-ready start command. Replace `CMD npm run dev` with `CMD node index.js`.

Ensure all sensitive environment variables are properly secured and not committed to version control. The .env file should be listed in .gitignore and managed through secure deployment pipelines.

Consider implementing health check endpoints that Docker can use to monitor container health, and configure proper logging to ensure debugging capabilities in production environments.

---

**Container Access:** http://localhost:32638
**Swagger Docs:** http://localhost:32638/api-docs
**Database:** PostgreSQL running on internal Docker network (port 5432)
