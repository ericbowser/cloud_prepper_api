// middleware/backup.js - Backup-specific middleware for CompTIA Prepper
const logger = require('../logs/prepperLog');
const fs = require('fs').promises;
const path = require('path');

const _logger = logger();

// Backup directory configuration
const BACKUP_DIR = 'C:/Projects/cloud_prepper_api/backups';
const MAX_BACKUP_SIZE = 100 * 1024 * 1024; // 100MB max backup size
const MAX_BACKUPS_ALLOWED = 50; // Maximum number of backups to keep

/**
 * Validate backup request parameters
 */
const validateBackupRequest = (req, res, next) => {
    try {
        const { fileName, confirmPassword } = req.body;

        // For restore operations
        if (req.path.includes('/restore')) {
            if (!fileName) {
                return res.status(400).json({
                    success: false,
                    error: 'Backup fileName is required'
                });
            }

            if (!confirmPassword) {
                return res.status(400).json({
                    success: false,
                    error: 'Confirmation password is required'
                });
            }

            // Validate filename format
            if (!fileName.match(/^cloud_prepper_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid backup filename format'
                });
            }
        }

        next();
    } catch (error) {
        _logger.error('Backup request validation failed', { error: error.message });
        res.status(400).json({
            success: false,
            error: 'Invalid backup request parameters'
        });
    }
};

/**
 * Check backup directory health and capacity
 */
const checkBackupDirectory = async (req, res, next) => {
    try {
        // Ensure backup directory exists
        try {
            await fs.access(BACKUP_DIR);
        } catch {
            _logger.info('Creating backup directory', { path: BACKUP_DIR });
            await fs.mkdir(BACKUP_DIR, { recursive: true });
        }

        // Check number of existing backups
        const files = await fs.readdir(BACKUP_DIR);
        const backupFiles = files.filter(file => 
            file.endsWith('.sql') && 
            file.includes('cloud_prepper_backup')
        );

        if (backupFiles.length >= MAX_BACKUPS_ALLOWED) {
            _logger.warn('Maximum backup limit reached', { 
                currentBackups: backupFiles.length,
                maxAllowed: MAX_BACKUPS_ALLOWED
            });
            
            // Optional: Auto-cleanup oldest backups
            if (req.query.autoCleanup === 'true') {
                await cleanupOldBackups(5); // Keep only 5 oldest
                _logger.info('Auto-cleanup performed');
            } else {
                return res.status(507).json({
                    success: false,
                    error: `Maximum backup limit reached (${MAX_BACKUPS_ALLOWED}). Please delete old backups or use autoCleanup=true`,
                    currentBackups: backupFiles.length,
                    maxAllowed: MAX_BACKUPS_ALLOWED
                });
            }
        }

        // Add backup stats to request for logging
        req.backupStats = {
            totalBackups: backupFiles.length,
            backupDir: BACKUP_DIR
        };

        next();
    } catch (error) {
        _logger.error('Backup directory check failed', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to verify backup directory',
            details: error.message
        });
    }
};

/**
 * Validate backup file before restore
 */
const validateBackupFile = async (req, res, next) => {
    try {
        const { fileName } = req.body;
        const filePath = path.join(BACKUP_DIR, fileName);

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({
                success: false,
                error: 'Backup file not found',
                fileName: fileName
            });
        }

        // Check file size
        const stats = await fs.stat(filePath);
        
        if (stats.size === 0) {
            return res.status(400).json({
                success: false,
                error: 'Backup file is empty or corrupted',
                fileName: fileName
            });
        }

        if (stats.size > MAX_BACKUP_SIZE) {
            return res.status(400).json({
                success: false,
                error: 'Backup file exceeds maximum size limit',
                fileName: fileName,
                fileSize: stats.size,
                maxSize: MAX_BACKUP_SIZE
            });
        }

        // Basic SQL validation - check if file starts with SQL comments
        const content = await fs.readFile(filePath, 'utf8');
        const firstLine = content.split('\n')[0];
        
        if (!firstLine.includes('--') && !firstLine.includes('CompTIA Prepper')) {
            _logger.warn('Suspicious backup file format', { 
                fileName, 
                firstLine: firstLine.substring(0, 50) 
            });
            return res.status(400).json({
                success: false,
                error: 'Invalid backup file format - does not appear to be a valid SQL backup'
            });
        }

        // Add file info to request
        req.backupFileInfo = {
            fileName: fileName,
            filePath: filePath,
            fileSize: stats.size,
            createdAt: stats.birthtime,
            modifiedAt: stats.mtime
        };

        _logger.info('Backup file validation passed', { fileName, fileSize: stats.size });
        next();
    } catch (error) {
        _logger.error('Backup file validation failed', { 
            error: error.message,
            fileName: req.body.fileName
        });
        res.status(500).json({
            success: false,
            error: 'Failed to validate backup file',
            details: error.message
        });
    }
};

/**
 * Log backup operations for audit trail
 */
const logBackupOperation = (operationType) => {
    return (req, res, next) => {
        const startTime = Date.now();

        // Log operation start
        _logger.info(`Backup operation started: ${operationType}`, {
            operation: operationType,
            adminId: req.user?.id,
            adminUsername: req.user?.username,
            timestamp: new Date().toISOString(),
            ip: req.ip,
            userAgent: req.get('user-agent')
        });

        // Capture original res.json to log completion
        const originalJson = res.json.bind(res);
        res.json = (data) => {
            const duration = Date.now() - startTime;
            
            _logger.info(`Backup operation completed: ${operationType}`, {
                operation: operationType,
                adminId: req.user?.id,
                adminUsername: req.user?.username,
                success: data.success !== false,
                duration: `${duration}ms`,
                statusCode: res.statusCode
            });

            return originalJson(data);
        };

        next();
    };
};

/**
 * Prevent concurrent backup operations from same user
 */
const preventConcurrentOperations = (() => {
    const activeOperations = new Map();

    return (req, res, next) => {
        const userId = req.user.id;
        
        if (activeOperations.has(userId)) {
            _logger.warn('Concurrent backup operation attempted', { 
                userId, 
                username: req.user.username 
            });
            return res.status(409).json({
                success: false,
                error: 'Another backup operation is already in progress for your account',
                message: 'Please wait for the current operation to complete'
            });
        }

        // Mark operation as active
        activeOperations.set(userId, {
            startTime: Date.now(),
            operation: req.path
        });

        // Clean up on response
        res.on('finish', () => {
            activeOperations.delete(userId);
        });

        next();
    };
})();

/**
 * Helper function to cleanup old backups
 */
async function cleanupOldBackups(keepCount = 10) {
    try {
        const files = await fs.readdir(BACKUP_DIR);
        const backupFiles = files.filter(file => 
            file.endsWith('.sql') && 
            file.includes('cloud_prepper_backup')
        );

        if (backupFiles.length <= keepCount) {
            return { deleted: 0, kept: backupFiles.length };
        }

        // Get file stats
        const filesWithStats = await Promise.all(
            backupFiles.map(async (file) => {
                const filePath = path.join(BACKUP_DIR, file);
                const stats = await fs.stat(filePath);
                return { file, mtime: stats.mtime };
            })
        );

        // Sort by modification time (oldest first)
        filesWithStats.sort((a, b) => a.mtime - b.mtime);

        // Delete oldest files
        const toDelete = filesWithStats.slice(0, filesWithStats.length - keepCount);
        let deletedCount = 0;

        for (const { file } of toDelete) {
            const filePath = path.join(BACKUP_DIR, file);
            await fs.unlink(filePath);
            _logger.info('Old backup deleted', { fileName: file });
            deletedCount++;
        }

        return { deleted: deletedCount, kept: keepCount };
    } catch (error) {
        _logger.error('Cleanup old backups failed', { error: error.message });
        throw error;
    }
}

/**
 * Add backup metadata to response
 */
const addBackupMetadata = async (req, res, next) => {
    try {
        const files = await fs.readdir(BACKUP_DIR);
        const backupFiles = files.filter(file => 
            file.endsWith('.sql') && 
            file.includes('cloud_prepper_backup')
        );

        req.backupMetadata = {
            totalBackups: backupFiles.length,
            maxBackupsAllowed: MAX_BACKUPS_ALLOWED,
            backupDirectory: BACKUP_DIR,
            storageUsed: await calculateDirectorySize(BACKUP_DIR),
            lastChecked: new Date().toISOString()
        };

        next();
    } catch (error) {
        // Non-critical error, continue without metadata
        _logger.warn('Failed to add backup metadata', { error: error.message });
        req.backupMetadata = null;
        next();
    }
};

/**
 * Calculate total size of directory
 */
async function calculateDirectorySize(dirPath) {
    try {
        const files = await fs.readdir(dirPath);
        let totalSize = 0;

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.stat(filePath);
            totalSize += stats.size;
        }

        return formatBytes(totalSize);
    } catch {
        return 'Unknown';
    }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = {
    validateBackupRequest,
    checkBackupDirectory,
    validateBackupFile,
    logBackupOperation,
    preventConcurrentOperations,
    addBackupMetadata,
    cleanupOldBackups,
    
    // Export configuration for testing
    BACKUP_DIR,
    MAX_BACKUP_SIZE,
    MAX_BACKUPS_ALLOWED
};
