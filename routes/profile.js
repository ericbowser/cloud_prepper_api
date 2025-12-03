const express = require('express');
const router = express.Router();
const upload = require('../config/upload');
const { processAvatar, deleteOldAvatar } = require('../utils/imageProcessor');
const jwt = require('jsonwebtoken');

// JWT Secret (should match your auth routes)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

/**
 * Middleware to verify JWT token
 */
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            success: false, 
            message: 'Access token required' 
        });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ 
                success: false, 
                message: 'Invalid or expired token' 
            });
        }
        req.user = user;
        next();
    });
};

/**
 * Upload profile avatar
 * POST /api/profile/avatar
 */
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        // Get database connection from app
        const db = req.app.get('db');
        if (!db) {
            throw new Error('Database connection not available');
        }

        const userId = req.user.id;

        // Get current user to check for existing avatar
        const userQuery = 'SELECT avatar_url FROM prepper."user" WHERE id = $1';
        const userResult = await db.query(userQuery, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const oldAvatarUrl = userResult.rows[0].avatar_url;

        // Process the uploaded image
        const processedPath = await processAvatar(req.file.path);
        
        // Create relative URL for database storage
        const relativePath = processedPath.replace(/\\/g, '/').split('/uploads/')[1];
        const avatarUrl = `/uploads/${relativePath}`;

        // Update user's avatar_url in database
        const updateQuery = `
            UPDATE prepper."user" 
            SET avatar_url = $1 
            WHERE id = $2 
            RETURNING id, username, email, role, avatar_url
        `;
        
        const result = await db.query(updateQuery, [avatarUrl, userId]);

        // Delete old avatar if it exists
        if (oldAvatarUrl) {
            await deleteOldAvatar(oldAvatarUrl);
        }

        res.json({
            success: true,
            message: 'Profile avatar updated successfully',
            user: result.rows[0]
        });

    } catch (error) {
        console.error('Avatar upload error:', error);
        
        // Clean up uploaded file if processing failed
        if (req.file && req.file.path) {
            try {
                const fs = require('fs').promises;
                await fs.unlink(req.file.path);
            } catch (unlinkError) {
                console.error('Error deleting failed upload:', unlinkError);
            }
        }

        res.status(500).json({
            success: false,
            message: 'Failed to upload avatar',
            error: error.message
        });
    }
});

/**
 * Delete profile avatar
 * DELETE /api/profile/avatar
 */
router.delete('/avatar', authenticateToken, async (req, res) => {
    try {
        const db = req.app.get('db');
        if (!db) {
            throw new Error('Database connection not available');
        }

        const userId = req.user.id;

        // Get current avatar
        const userQuery = 'SELECT avatar_url FROM prepper."user" WHERE id = $1';
        const userResult = await db.query(userQuery, [userId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const avatarUrl = userResult.rows[0].avatar_url;

        // Update database to remove avatar
        const updateQuery = `
            UPDATE prepper."user" 
            SET avatar_url = NULL 
            WHERE id = $1 
            RETURNING id, username, email, role, avatar_url
        `;
        
        const result = await db.query(updateQuery, [userId]);

        // Delete avatar file
        if (avatarUrl) {
            await deleteOldAvatar(avatarUrl);
        }

        res.json({
            success: true,
            message: 'Profile avatar deleted successfully',
            user: result.rows[0]
        });

    } catch (error) {
        console.error('Avatar deletion error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete avatar',
            error: error.message
        });
    }
});

/**
 * Get user profile
 * GET /api/profile
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const db = req.app.get('db');
        if (!db) {
            throw new Error('Database connection not available');
        }

        const userId = req.user.id;

        const query = `
            SELECT id, username, email, role, avatar_url, user_type 
            FROM prepper."user" 
            WHERE id = $1
        `;
        
        const result = await db.query(query, [userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });

    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch profile',
            error: error.message
        });
    }
});

module.exports = router;
