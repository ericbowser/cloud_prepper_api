# Docker Setup Guide

This project supports two Docker configurations for PostgreSQL:

## Option 1: Local PostgreSQL (Default)

**File:** `compose.yaml`

Connects to PostgreSQL running on your host machine.

### Setup:
1. Ensure PostgreSQL is running locally on your machine
2. Update `.env` with your local PostgreSQL credentials:
   ```env
   DB_USER=postgres
   DB_PASSWORD=your_password
   DB_HOST=localhost  # Not needed in compose, but for local dev
   DB_PORT=5432
   ```
3. Run: `docker-compose up --build`

### How it works:
- Uses `host.docker.internal` to connect from container to host machine
- Works on Windows and Mac automatically
- On Linux, may need to use `172.17.0.1` or configure Docker network

## Option 2: Docker PostgreSQL with Volume

**File:** `compose.docker-db.yaml`

Runs PostgreSQL in a Docker container with persistent storage.

### Setup:
1. Update `.env` with PostgreSQL credentials:
   ```env
   DB_USER=postgres
   DB_PASSWORD=your_password
   DB_PORT=5432
   POSTGRES_DB=ericbo
   ```
2. Run: `docker-compose -f compose.docker-db.yaml up --build`

### How it works:
- Creates a PostgreSQL container
- Uses a Docker **named volume** (`pg_data`) for data persistence
- Data survives container restarts/removals
- To completely remove data: `docker-compose -f compose.docker-db.yaml down -v`

## Understanding Docker Volumes

### Named Volumes (Recommended)
- **Location:** Managed by Docker (usually `/var/lib/docker/volumes/`)
- **Persistence:** Data survives container removal
- **Backup:** Easy to backup/restore
- **Example:** `pg_data` volume in `compose.docker-db.yaml`

### Benefits of Docker Volumes:
1. **Isolation:** Database runs in container, separate from host
2. **Portability:** Easy to move between machines
3. **Consistency:** Same environment for all developers
4. **Cleanup:** Easy to reset by removing volume

### Volume Commands:
```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect cloud_prepper_api_pg_data

# Backup volume (example)
docker run --rm -v cloud_prepper_api_pg_data:/data -v $(pwd):/backup alpine tar czf /backup/pg_backup.tar.gz /data

# Remove volume (WARNING: deletes data)
docker volume rm cloud_prepper_api_pg_data
```

## Switching Between Configurations

### From Local to Docker DB:
1. Stop current setup: `docker-compose down`
2. Start with Docker DB: `docker-compose -f compose.docker-db.yaml up`
3. Run database migrations on the new PostgreSQL instance

### From Docker DB to Local:
1. Stop Docker setup: `docker-compose -f compose.docker-db.yaml down`
2. Start with local: `docker-compose up`
3. Ensure local PostgreSQL is running and accessible

## Troubleshooting

### Can't connect to local PostgreSQL from container:
- **Windows/Mac:** `host.docker.internal` should work automatically
- **Linux:** Try using your host IP or add to `extra_hosts`:
  ```yaml
  extra_hosts:
    - "host.docker.internal:172.17.0.1"
  ```

### Database connection errors:
- Verify PostgreSQL is running: `pg_isready` or check service status
- Check firewall settings
- Verify credentials in `.env` file
- Check database name matches (default: `ericbo`)

### Volume not persisting:
- Ensure you're using named volumes (not bind mounts)
- Check volume exists: `docker volume ls`
- Verify volume is mounted: `docker inspect <container_name>`

## Recommended Approach

**For Development:**
- Use **Local PostgreSQL** (compose.yaml) - simpler, direct access to your existing database

**For Production/Testing:**
- Use **Docker PostgreSQL** (compose.docker-db.yaml) - isolated, consistent environment
