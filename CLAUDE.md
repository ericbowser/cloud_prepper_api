# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Local Development:**
- `npm run dev` - Start development server with nodemon (installs dependencies automatically)
- `npm install` - Install dependencies
- `npm run clean` - Remove node_modules and package-lock.json, then reinstall

**Docker Development:**
- `npm run build` - Build Docker image as `ericbowser/cloud_prepper_api`
- `npm run run` - Run Docker container on port 32638 with env file
- `docker-compose up` - Start full application with PostgreSQL database

**Access Points:**
- API Server: http://localhost:32636 (local dev) or http://localhost:32638 (Docker)
- Swagger Documentation: http://localhost:[PORT]/api-docs

## Architecture Overview

This is a Node.js REST API for a cloud certification exam preparation platform. The application manages exam questions for CompTIA Cloud+ and AWS Certified Architect Associate certifications.

**Key Components:**
- `index.js` - Application entry point, sets up Express server and Swagger UI
- `server.js` - Main router with all API endpoints and Swagger documentation
- `documentdb/client.js` - PostgreSQL database connection management
- `email/SendEmail.js` - Email functionality using nodemailer
- `logs/prepperLog.js` - Logging configuration using log4js
- `swagger.js` - OpenAPI specification configuration

**Database Schema:**
- `prepper.comptia_cloud_plus_questions` - CompTIA Cloud+ exam questions
- `prepper.aws_certified_architect_associate_questions` - AWS exam questions

Both tables share the same schema with fields: category, difficulty, domain, question_text, options (JSON), correct_answer, explanation, explanation_details (JSON), multiple_answers, correct_answers (array).

**Configuration:**
- Environment variables: DB_USER, DB_PASSWORD (must be set for database connection)
- `env.json` - Contains static configuration including ports, database host, and email settings
- Default ports: 32636 (development), 32638 (Docker)

## API Endpoints

**Question Management:**
- `GET /getExamQuestions` - Retrieve all questions for both certifications
- `POST /addQuestion` - Add new question (specify certification: 'aws' or 'comptia')
- `PUT /updateQuestion/:id` - Update existing question by ID

**Utility:**
- `POST /sendEmail` - Send email with specified details
- `GET /api-docs` - Swagger UI documentation

**Database Connection:**
The application maintains a persistent PostgreSQL connection through the `ps` variable in server.js. Connection is established on first API call and reused for subsequent requests.

## Environment Setup

1. Set required environment variables: `DB_USER`, `DB_PASSWORD`
2. Ensure PostgreSQL is running on localhost:5432 with database 'postgres'
3. Database should have 'prepper' schema with the two question tables
4. For email functionality, Gmail app password is configured in env.json

## Important Notes

- The application uses a singleton database connection pattern
- All database queries use parameterized statements for security
- JSON fields (options, explanation_details) are automatically stringified/parsed
- Multiple choice questions use `multiple_answers` flag and `correct_answers` array
- Comprehensive error logging is implemented throughout the application
- CORS is enabled for cross-origin requests