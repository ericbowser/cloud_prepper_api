// Simple backup routes test
const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../../middleware/auth');
const logger = require('../../logs/prepperLog');

const _logger = logger();

// Test status endpoint
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    _logger.info('Backup status check', { adminId: req.user.id });
    res.json({
      success: true,
      status: 'idle',
      message: 'Backup system is operational'
    });
  } catch (error) {
    _logger.error('Status check failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get backup status'
    });
  }
});

// Test list endpoint
router.get('/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    _logger.info('List backups', { adminId: req.user.id });
    res.json({
      success: true,
      backups: [],
      message: 'No backups available yet'
    });
  } catch (error) {
    _logger.error('List backups failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to list backups'
    });
  }
});

console.log('Backup test router initialized');
module.exports = router;
