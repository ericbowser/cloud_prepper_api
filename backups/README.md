# Database Backup Directory

This directory contains SQL backup files for the CompTIA Prepper database.

## Security Notice
⚠️ **Admin Access Only** - All backup operations require admin authentication

## Available Endpoints

### Generate Backup
- **GET** `/api/backup/generate-restore-script`
- Creates a timestamped SQL backup file
- Returns download URL and backup metadata

### List Backups
- **GET** `/api/backup/list` 
- Returns list of all available backup files with metadata

### Download Backup
- **GET** `/api/backup/download/:filename`
- Downloads specific backup file
- Validates filename format for security

### Restore Database
- **POST** `/api/backup/restore`
- ⚠️ **DANGEROUS** - Completely replaces current database
- Requires confirmation password: `CONFIRM_RESTORE_DATABASE`
- Full transaction rollback on failure

## File Naming Convention
```
cloud_prepper_backup_YYYY-MM-DDTHH-MM-SS.sql
```

## Authentication Required
All endpoints require:
1. Valid JWT bearer token
2. Admin role privileges

## Logging
All backup operations are logged with admin user details for audit trail.
