const express = require('express');
const bcrypt = require('bcrypt');
const { generateToken, authenticateToken, requireAdmin } = require('../middleware/auth');
const { connectLocalPostgres } = require('../documentdb/client');
const logger = require('../logs/prepperLog');

const router = express.Router();
const _logger = logger();

let ps = null;

// Salt rounds for bcrypt
const SALT_ROUNDS = 10;

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new user
 *     description: Create a new user account. Admin role can only be assigned by existing admin.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 50
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *               role:
 *                 type: string
 *                 enum: [user, admin]
 *                 default: user
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Invalid input or user already exists
 *       500:
 *         description: Server error
 */
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, role = 'user' } = req.body;

        // Validation
        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username, email, and password are required'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters long'
            });
        }

        // Connect to database
        if (!ps) {
            ps = await connectLocalPostgres();
        }

        // Check if user already exists
        const existingUser = await ps.query(
            'SELECT id FROM prepper.users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User with this email or username already exists'
            });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        // Insert new user (only allow 'user' role for self-registration)
        const userRole = role === 'admin' ? 'user' : role; // Prevent self-assignment of admin
        const result = await ps.query(
            `INSERT INTO prepper.users (username, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, email, role, created_at`,
            [username, email, passwordHash, userRole]
        );

        const newUser = result.rows[0];
        _logger.info('New user registered', { userId: newUser.id, username: newUser.username });

        // Generate token
        const token = generateToken(newUser);

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                role: newUser.role
            },
            token
        });

    } catch (error) {
        _logger.error('Registration error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to register user'
        });
    }
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     description: Authenticate user and return JWT token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 *       500:
 *         description: Server error
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        // Connect to database
        if (!ps) {
            ps = await connectLocalPostgres();
        }

        // Find user
        const result = await ps.query(
            'SELECT * FROM prepper.users WHERE email = $1 AND is_active = true',
            [email]
        );

        if (result.rows.length === 0) {
            _logger.warn('Login attempt with invalid email', { email });
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        const user = result.rows[0];

        // Validate password hash exists
        if (!user.password_hash) {
            _logger.error('User has no password hash', { userId: user.id, email });
            return res.status(500).json({
                success: false,
                message: 'Account configuration error'
            });
        }

        // Get password hash - ensure it's a string and handle encoding
        // PostgreSQL may return it as a Buffer or with encoding issues
        let passwordHash = user.password_hash;
        if (Buffer.isBuffer(passwordHash)) {
            passwordHash = passwordHash.toString('utf8');
        } else {
            passwordHash = String(passwordHash).trim();
        }

        // Validate bcrypt hash format (should start with $2a$, $2b$, or $2y$)
        if (!passwordHash.startsWith('$2')) {
            _logger.error('Invalid password hash format', { 
                userId: user.id, 
                hashPrefix: passwordHash.substring(0, 10),
                hashType: typeof passwordHash
            });
            return res.status(500).json({
                success: false,
                message: 'Password hash format error. Hash must be a valid bcrypt hash.'
            });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, passwordHash);

        if (!isValidPassword) {
            _logger.warn('Login attempt with invalid password', { userId: user.id, email });
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        // Update last login
        await ps.query(
            'UPDATE prepper.users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );

        _logger.info('User logged in', { userId: user.id, username: user.username });

        // Generate token
        const token = generateToken(user);

        res.json({
            success: true,
            message: 'Login successful',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            },
            token
        });

    } catch (error) {
        _logger.error('Login error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to login'
        });
    }
});

/**
 * @swagger
 * /auth/verify:
 *   get:
 *     summary: Verify JWT token
 *     description: Verify if the current token is valid and return user info
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token is valid
 *       401:
 *         description: Invalid or missing token
 */
router.get('/verify', authenticateToken, async (req, res) => {
    try {
        // Connect to database
        if (!ps) {
            ps = await connectLocalPostgres();
        }

        // Get fresh user data
        const result = await ps.query(
            'SELECT id, username, email, role, created_at, last_login FROM prepper.users WHERE id = $1 AND is_active = true',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive'
            });
        }

        const user = result.rows[0];

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                createdAt: user.created_at,
                lastLogin: user.last_login
            }
        });

    } catch (error) {
        _logger.error('Token verification error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to verify token'
        });
    }
});

/**
 * @swagger
 * /auth/users:
 *   get:
 *     summary: Get all users (Admin only)
 *     description: Retrieve list of all users. Requires admin role.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 *       403:
 *         description: Admin access required
 */
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        if (!ps) {
            ps = await connectLocalPostgres();
        }

        const result = await ps.query(
            `SELECT id, username, email, role, created_at, last_login, is_active 
             FROM prepper.users 
             ORDER BY created_at DESC`
        );

        res.json({
            success: true,
            users: result.rows
        });

    } catch (error) {
        _logger.error('Error fetching users', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users'
        });
    }
});

/**
 * @swagger
 * /auth/change-password:
 *   post:
 *     summary: Change user password
 *     description: Allow user to change their own password
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Current password incorrect
 */
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long'
            });
        }

        if (!ps) {
            ps = await connectLocalPostgres();
        }

        // Get user with password hash
        const result = await ps.query(
            'SELECT password_hash FROM prepper.users WHERE id = $1',
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Validate password hash exists
        if (!result.rows[0].password_hash) {
            _logger.error('User has no password hash', { userId: req.user.id });
            return res.status(500).json({
                success: false,
                message: 'Account configuration error'
            });
        }

        // Get password hash - ensure it's a string and handle encoding
        let passwordHash = result.rows[0].password_hash;
        if (Buffer.isBuffer(passwordHash)) {
            passwordHash = passwordHash.toString('utf8');
        } else {
            passwordHash = String(passwordHash).trim();
        }

        // Verify current password
        const isValidPassword = await bcrypt.compare(currentPassword, passwordHash);

        if (!isValidPassword) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect'
            });
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

        // Update password
        await ps.query(
            'UPDATE prepper.users SET password_hash = $1 WHERE id = $2',
            [newPasswordHash, req.user.id]
        );

        _logger.info('User changed password', { userId: req.user.id });

        res.json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (error) {
        _logger.error('Password change error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to change password'
        });
    }
});

/**
 * @swagger
 * /auth/setup-admin:
 *   post:
 *     summary: Setup first admin account (One-time setup)
 *     description: Creates the first admin account if no admin exists. Only works when no admin accounts exist in the system.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       201:
 *         description: Admin account created successfully
 *       400:
 *         description: Invalid input or admin already exists
 *       500:
 *         description: Server error
 */
router.post('/setup-admin', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validation
        if (!username || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username, email, and password are required'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters long'
            });
        }

        // Connect to database
        if (!ps) {
            ps = await connectLocalPostgres();
        }

        // Check if any admin already exists
        const adminCheck = await ps.query(
            'SELECT id FROM prepper.users WHERE role = $1',
            ['admin']
        );

        if (adminCheck.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Admin account already exists. Use /auth/set-password endpoint instead.'
            });
        }

        // Check if user already exists
        const existingUser = await ps.query(
            'SELECT id FROM prepper.users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'User with this email or username already exists'
            });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        // Insert admin user
        const result = await ps.query(
            `INSERT INTO prepper.users (username, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, email, role, created_at`,
            [username, email, passwordHash, 'admin']
        );

        const newAdmin = result.rows[0];
        _logger.info('First admin account created', { userId: newAdmin.id, username: newAdmin.username });

        // Generate token
        const token = generateToken(newAdmin);

        res.status(201).json({
            success: true,
            message: 'Admin account created successfully',
            user: {
                id: newAdmin.id,
                username: newAdmin.username,
                email: newAdmin.email,
                role: newAdmin.role
            },
            token
        });

    } catch (error) {
        _logger.error('Setup admin error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to create admin account'
        });
    }
});

/**
 * @swagger
 * /auth/set-password:
 *   post:
 *     summary: Set or reset password for a user (Admin only)
 *     description: Allows admin to set or reset password for any user account. Useful for setting up admin accounts.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - newPassword
 *             properties:
 *               userId:
 *                 type: integer
 *                 description: ID of the user whose password to set
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Password set successfully
 *       400:
 *         description: Invalid input
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
router.post('/set-password', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { userId, newPassword } = req.body;

        if (!userId || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'User ID and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long'
            });
        }

        if (!ps) {
            ps = await connectLocalPostgres();
        }

        // Check if user exists
        const userCheck = await ps.query(
            'SELECT id, username, email, role FROM prepper.users WHERE id = $1',
            [userId]
        );

        if (userCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Hash new password
        const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

        // Update password
        await ps.query(
            'UPDATE prepper.users SET password_hash = $1 WHERE id = $2',
            [newPasswordHash, userId]
        );

        const targetUser = userCheck.rows[0];
        _logger.info('Admin set password for user', { 
            adminId: req.user.id, 
            targetUserId: userId, 
            targetUsername: targetUser.username 
        });

        res.json({
            success: true,
            message: 'Password set successfully',
            user: {
                id: targetUser.id,
                username: targetUser.username,
                email: targetUser.email,
                role: targetUser.role
            }
        });

    } catch (error) {
        _logger.error('Set password error', { error: error.message });
        res.status(500).json({
            success: false,
            message: 'Failed to set password'
        });
    }
});

module.exports = router;
