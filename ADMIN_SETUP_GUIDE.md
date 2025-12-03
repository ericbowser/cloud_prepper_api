# CloudPrepper Admin Dashboard Setup Guide

## 🎯 Overview

Your CloudPrepper application now has a fully functional admin dashboard with:
- **JWT Authentication** with login/register system
- **Database Backup & Restore** with admin-only access
- **OCR Text Extraction** for processing question images
- **Question Management** (coming soon)
- **User Management** (coming soon)

## 🔧 Setup Instructions

### 1. Database Setup

First, create the users table for authentication:

```bash
# Navigate to backend directory
cd C:/Projects/cloud_prepper_api

# Run the setup script in your PostgreSQL database
psql -h localhost -U ericbo -d cloud_prepper -f setup_auth.sql
```

### 2. Backend Setup

The backend is already configured and ready to run:

```bash
cd C:/Projects/cloud_prepper_api

# Install dependencies (if not already installed)
npm install jsonwebtoken bcrypt

# Start the backend server
npm start
# or
node index.js
```

The backend will start on: **http://localhost:36236**

### 3. Frontend Setup

The frontend is already configured and ready:

```bash
cd C:/Projects/CloudPrepper

# Start the frontend development server
npm run dev
# or
npm start
```

The frontend will start on: **http://localhost:32637**

## 🔑 Default Admin Login

After running the database setup script, you'll have a default admin account:

- **Email:** `admin@comptiaprepper.com`
- **Password:** `admin123`

**⚠️ IMPORTANT:** Change this password immediately after your first login!

## 🚀 Accessing the Admin Dashboard

1. **Start both servers** (backend on :36236, frontend on :32637)
2. **Open browser** to http://localhost:32637
3. **Login** with admin credentials
4. **Click "Admin Panel"** button in the header
5. **Navigate to "Database Backup"** tab to test the backup system

## 📋 Admin Dashboard Features

### 🏠 Overview Tab
- System status cards
- Quick action buttons
- Recent activity log
- Welcome message

### 💾 Database Backup Tab
- **Dashboard**: System overview, backup statistics, recommendations
- **Backup Files**: List all backups, download, generate new backups
- **Restore**: Restore database from backup files (requires confirmation)

### 📸 OCR Tool Tab
- Upload images of exam questions
- Extract text using OCR technology
- Process multiple images at once

### ❓ Question Manager Tab (Coming Soon)
- Add/edit exam questions
- Bulk import capabilities
- Question categorization

### 👥 User Management Tab (Coming Soon)
- Manage user accounts
- Role assignments
- Usage analytics

## 🔐 API Endpoints

### Authentication Endpoints (Public)
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration  
- `POST /api/auth/setup-admin` - Setup first admin (if none exists)

### Authentication Endpoints (Protected)
- `GET /api/auth/verify` - Verify JWT token
- `GET /api/auth/users` - List all users (Admin only)
- `POST /api/auth/change-password` - Change password
- `POST /api/auth/set-password` - Set user password (Admin only)

### Backup Endpoints (Admin Only)
- `GET /api/backup/generate-restore-script` - Generate backup
- `GET /api/backup/list` - List all backup files
- `GET /api/backup/download/:filename` - Download backup file
- `POST /api/backup/restore` - Restore from backup

### Question Endpoints
- `GET /api/getExamQuestions` - Get all questions (Public)
- `POST /api/addQuestion` - Add question (Admin only)
- `PUT /api/updateQuestion/:id` - Update question (Admin only)
- `DELETE /api/deleteQuestion/:id` - Delete question (Admin only)

## 🛡️ Security Features

### JWT Authentication
- 24-hour token expiration
- Role-based access control
- Secure password hashing with bcrypt

### Backup Security
- Admin-only access
- Rate limiting (3 requests per 5 minutes)
- Filename validation
- Confirmation required for restore operations

### Input Validation
- SQL injection protection
- File type validation
- Password complexity requirements

## 🔧 Configuration Files

### Frontend (C:/Projects/CloudPrepper/env.json)
```json
{
  "HOST": "localhost",
  "PORT": "32637",
  "CLOUD_PREPPER_BASE_URL": "http://localhost:36236",
  "CLOUD_PREPPER_GET_QUESTIONS": "/api/getExamQuestions",
  "CLOUD_PREPPER_ADD_QUESTION": "/api/addQuestion",
  "CLOUD_PREPPER_UPDATE_QUESTION": "/api/updateQuestion"
}
```

### Backend (C:/Projects/cloud_prepper_api/env.json)
```json
{
  "HOST": "localhost",
  "PORT": "36236",
  "DB_HOST": "localhost",
  "DB_PORT": "5432",
  "DB_USER": "ericbo",
  "DB_SERVER": "postgres",
  "DB_PASSWORD": "1007",
  "JWT_SECRET": "your-generated-secret-here"
}
```

## 🧪 Testing the System

### 1. Test Authentication
```bash
# Test login
curl -X POST http://localhost:36236/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@comptiaprepper.com", "password": "admin123"}'
```

### 2. Test Backup System (Admin Only)
```bash
# First login to get token, then:
curl -X GET http://localhost:36236/api/backup/list \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 3. Test Question Retrieval
```bash
# Public endpoint
curl http://localhost:36236/api/getExamQuestions
```

## 📊 Database Tables

The system uses these main tables:
- `prepper.users` - User accounts and authentication
- `prepper.comptia_cloud_plus_questions` - CompTIA questions
- `prepper.aws_certified_architect_associate_questions` - AWS questions

## 🚨 Important Notes

1. **Change default password** immediately after first login
2. **Backup regularly** - Use the backup system to create restore points
3. **JWT Secret** - Keep the JWT_SECRET secure and never expose it
4. **Admin Access** - Only grant admin role to trusted users
5. **Database Restore** - Always test restores in a development environment first

## 🐛 Troubleshooting

### Backend won't start
- Check PostgreSQL connection
- Verify env.json configuration
- Ensure JWT_SECRET is set

### Frontend can't connect
- Verify backend is running on port 36236
- Check CORS settings
- Confirm API endpoints in env.json

### Login fails
- Ensure users table exists
- Check password hash format
- Verify JWT_SECRET matches between login and verification

### Backup fails
- Check admin permissions
- Verify database connection
- Ensure backup directory exists

## 📚 API Documentation

Once the backend is running, view the full API documentation at:
**http://localhost:36236/api-docs**

This provides interactive Swagger documentation for all endpoints.

## 🎉 You're Ready!

Your CloudPrepper admin dashboard is now fully functional with:
✅ JWT Authentication  
✅ Admin Dashboard  
✅ Database Backup & Restore  
✅ OCR Text Extraction  
✅ Question Management APIs  
✅ Comprehensive Security  

Login as admin and start managing your certification preparation platform!
