# CloudPrepper API

Backend API for CloudPrepper - A comprehensive certification exam preparation platform.

## 🚀 Quick Start

### Prerequisites
- Node.js 16+
- PostgreSQL 12+
- npm or yarn

### Project Structure
```
cloud_prepper_api/
├── config.js              # Configuration loader
├── env.json              # Environment config (NOT in git)
├── index.js              # Entry point
├── server.js             # Route definitions
├── middleware/
│   └── auth.js          # JWT authentication
├── routes/
│   ├── auth.js          # Authentication endpoints
│   └── backup.js        # Backup endpoints
├── documentdb/
│   └── client.js        # Database client
└── logs/                # Application logs
```

### Authentication

All protected endpoints require JWT authentication:

```javascript
// Request headers
Authorization: Bearer <your_jwt_token>
```

**User Roles:**
- `user` - Can access quiz questions and track progress
- `admin` - Full access including question management

### Available Scripts

- `npm run dev` - Start development server with auto-reload
- `npm run build` - Build Docker image
- `npm run clean` - Clean install dependencies

## 📝 Environment Configuration

Required environment variables in `env.json`:

| Variable | Description | Example                   |
|----------|-------------|---------------------------|
| `HOST` | Server host | `host_or_domain`          |
| `PORT` | Server port | `avail_port`              |
| `DB_HOST` | PostgreSQL host | `your_host`               |
| `DB_PORT` | PostgreSQL port | `uour_port`               |
| `DB_USER` | Database user | `postgres`                |
| `DB_PASSWORD` | Database password | `your_password`           |
| `JWT_SECRET` | JWT signing secret | `128+ char random string` |
| `GMAIL_APP_PASSWORD` | Email service password | `app_password`            |

## 🚨 Troubleshooting

### JWT Authentication Fails
- Verify `JWT_SECRET` is set
- Check that config.js is loading properly

### Database Connection Issues
- Verify PostgreSQL is running
- Ensure database and schema exist

### CORS Errors
- Frontend URL should be in allowed origins
- Check CORS configuration in `index.js`

## 📜 License

MIT License - See LICENSE file for details

## 👥 Contributing

1. Fork the repository
2. Create your feature branch
4. Submit pull request

## 🔗 Related Projects

- [CloudPrepper Frontend](https://github.com/ericbowser/CloudPrepper)
- Main repository for the React/TypeScript frontend

---

**Security Notice**: This project handles user authentication and sensitive data. Review `SECURITY_CHECKLIST.md` before deployment.
