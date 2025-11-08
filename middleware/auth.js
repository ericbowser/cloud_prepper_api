const jwt = require('jsonwebtoken');
const logger = require('../logs/prepperLog');

const _logger = logger();

// JWT secret - In production, use environment variable
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const JWT_EXPIRES_IN = '24h'; // Token expiration time

/**
 * Middleware to verify JWT token
 */
const authenticateToken = (req, res, next) => {
    try {
        // Get token from Authorization header (Bearer token) or cookie
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
        
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                message: 'Access token required' 
            });
        }

        // Verify token
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                _logger.warn('Invalid token attempt', { error: err.message });
                return res.status(403).json({ 
                    success: false, 
                    message: 'Invalid or expired token' 
                });
            }

            // Attach user info to request
            req.user = user;
            next();
        });
    } catch (error) {
        _logger.error('Auth middleware error', { error: error.message });
        res.status(500).json({ 
            success: false, 
            message: 'Authentication error' 
        });
    }
};

/**
 * Middleware to check if user is admin
 */
const requireAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ 
            success: false, 
            message: 'Authentication required' 
        });
    }

    if (req.user.role !== 'admin') {
        _logger.warn('Unauthorized admin access attempt', { 
            userId: req.user.id, 
            username: req.user.username 
        });
        return res.status(403).json({ 
            success: false, 
            message: 'Admin access required' 
        });
    }

    next();
};

/**
 * Generate JWT token
 */
const generateToken = (user) => {
    const payload = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

module.exports = {
    authenticateToken,
    requireAdmin,
    generateToken,
    JWT_SECRET,
    JWT_EXPIRES_IN
};
