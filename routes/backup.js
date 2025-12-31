// backup-endpoint.js - Database backup and restore functionality for CompTIA Prepper
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const logger = require('../logs/prepperLog');
const { DB_PORT, DB_HOST, DB_USER, DB_PASSWORD } = require('../env.json');

// Simple rate limiting for backup operations
const backupRateLimit = new Map();
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes
const MAX_BACKUP_REQUESTS = 3; // Max 3 backup operations per 5 minutes per user

// Track backup operations status
const backupStatus = new Map(); // userId -> { status, startTime, endTime, fileName, error }

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = backupRateLimit.get(userId) || [];
  
  // Remove old requests outside the window
  const validRequests = userRequests.filter(time => (now - time) < RATE_LIMIT_WINDOW);
  
  if (validRequests.length >= MAX_BACKUP_REQUESTS) {
    return false; // Rate limited
  }
  
  // Add current request
  validRequests.push(now);
  backupRateLimit.set(userId, validRequests);
  return true; // Allowed
}

const _logger = logger();
const router = express.Router();

// Lazy-initialize the database pool to avoid module load-time issues
let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: DB_HOST || 'localhost',
      port: parseInt(DB_PORT) || 5432,
      user: DB_USER,
      password: DB_PASSWORD,
      database: 'cloud_prepper'
    });
  }
  return pool;
}

/**
 * @swagger
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 * 
 * /api/backup/status:
 *   get:
 *     summary: Get backup operation status (Admin only)
 *     description: Returns the status of the last backup operation for the current user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Backup status information
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin access required
 */

// GET /api/backup/status
router.get('/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = req.user.id;
    const status = backupStatus.get(userId) || { status: 'idle' };
    
    let response = {
      success: true,
      status: status.status || 'idle'
    };

    if (status.status === 'completed' || status.status === 'failed') {
      response.lastBackup = {
        fileName: status.fileName,
        startTime: status.startTime,
        endTime: status.endTime,
        duration: status.endTime ? (new Date(status.endTime) - new Date(status.startTime)) : null
      };
      
      if (status.status === 'failed' && status.error) {
        response.lastBackup.error = status.error;
      }
    } else if (status.status === 'in_progress') {
      response.lastBackup = {
        startTime: status.startTime,
        duration: Date.now() - new Date(status.startTime)
      };
    }

    res.json(response);
  } catch (error) {
    _logger.error('Failed to get backup status', { 
      error: error.message, 
      adminId: req.user.id 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get backup status',
      details: error.message
    });
  }
});

// GET /api/backup/generate-restore-script
router.get('/generate-restore-script', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.user.id;
  const startTime = new Date().toISOString();
  
  try {
    // Check rate limit
    if (!checkRateLimit(userId)) {
      _logger.warn('Backup rate limit exceeded', { 
        adminId: userId, 
        adminUsername: req.user.username 
      });
      return res.status(429).json({
        success: false,
        error: 'Too many backup requests. Please wait before trying again.',
        retryAfter: Math.ceil(RATE_LIMIT_WINDOW / 1000)
      });
    }
    
    // Set status to in_progress
    backupStatus.set(userId, {
      status: 'in_progress',
      startTime: startTime
    });
    
    _logger.info('Admin starting database backup', { 
      adminId: userId, 
      adminUsername: req.user.username 
    });
    console.log('Starting database backup...');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFileName = `cloud_prepper_backup_${timestamp}.sql`;
    const backupDir = path.join(__dirname, '..', 'backups');
    const backupPath = path.join(backupDir, backupFileName);

    // Ensure backup directory exists
    await fs.mkdir(backupDir, { recursive: true });

    let sqlScript = await generateCompleteBackupScript();

    // Write to file
    await fs.writeFile(backupPath, sqlScript, 'utf8');

    const endTime = new Date().toISOString();
    
    // Update status to completed
    backupStatus.set(userId, {
      status: 'completed',
      startTime: startTime,
      endTime: endTime,
      fileName: backupFileName
    });

    _logger.info('Backup completed successfully', { 
      fileName: backupFileName, 
      fileSize: Buffer.byteLength(sqlScript, 'utf8'),
      adminId: userId 
    });

    res.json({
      success: true,
      message: 'Database backup generated successfully',
      fileName: backupFileName,
      filePath: backupPath,
      fileSize: Buffer.byteLength(sqlScript, 'utf8'),
      timestamp: endTime,
      tables: await getTableCounts(),
      downloadUrl: `/api/backup/download/${backupFileName}`
    });

  } catch (error) {
    const endTime = new Date().toISOString();
    
    // Update status to failed
    backupStatus.set(userId, {
      status: 'failed',
      startTime: startTime,
      endTime: endTime,
      error: error.message
    });
    
    _logger.error('Backup generation failed', { 
      error: error.message, 
      adminId: userId 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to generate backup',
      details: error.message
    });
  }
});

// GET /api/backup/download/:filename
router.get('/download/:filename', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const fileName = req.params.filename;
    
    _logger.info('Admin downloading backup', { 
      adminId: req.user.id, 
      adminUsername: req.user.username, 
      fileName: fileName 
    });
    
    const backupDir = path.join(__dirname, '..', 'backups');
    const filePath = path.join(backupDir, fileName);

    // Security check - ensure filename is valid
    if (!fileName.match(/^cloud_prepper_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/)) {
      _logger.warn('Invalid backup filename attempted', { 
        fileName, 
        adminId: req.user.id 
      });
      return res.status(400).json({ success: false, error: 'Invalid filename format' });
    }

    // Check if file exists
    await fs.access(filePath);

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const fileContent = await fs.readFile(filePath, 'utf8');
    res.send(fileContent);

  } catch (error) {
    _logger.error('Backup download failed', { 
      error: error.message, 
      fileName: req.params.filename,
      adminId: req.user.id 
    });
    res.status(404).json({
      success: false,
      error: 'Backup file not found',
      details: error.message
    });
  }
});

// GET /api/backup/list
router.get('/list', authenticateToken, requireAdmin, async (req, res) => {
  try {
    _logger.info('Admin listing backups', { 
      adminId: req.user.id, 
      adminUsername: req.user.username 
    });
    
    const backupDir = path.join(__dirname, '..', 'backups');

    try {
      await fs.access(backupDir);
    } catch {
      return res.json({ success: true, backups: [] });
    }

    const files = await fs.readdir(backupDir);
    const sqlFiles = files.filter(file => 
      file.endsWith('.sql') && 
      file.includes('cloud_prepper_backup') &&
      file.match(/^cloud_prepper_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/)
    );

    const backups = await Promise.all(sqlFiles.map(async file => {
      const filePath = path.join(backupDir, file);
      const stats = await fs.stat(filePath);
      return {
        fileName: file,
        createdAt: stats.birthtime,
        modifiedAt: stats.mtime,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        downloadUrl: `/api/backup/download/${file}`
      };
    }));

    // Sort by creation date (newest first)
    backups.sort((a, b) => b.createdAt - a.createdAt);

    res.json({
      success: true,
      backups: backups,
      totalBackups: backups.length
    });

  } catch (error) {
    _logger.error('List backups failed', { 
      error: error.message, 
      adminId: req.user.id 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list backups',
      details: error.message
    });
  }
});

// POST /api/backup/restore
router.post('/restore', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { fileName, confirmPassword } = req.body;

    // Security check - require admin confirmation
    if (confirmPassword !== 'CONFIRM_RESTORE_DATABASE') {
      _logger.warn('Invalid restore confirmation attempt', { 
        adminId: req.user.id, 
        fileName: fileName 
      });
      return res.status(403).json({
        success: false,
        error: 'Invalid confirmation password'
      });
    }

    const backupDir = path.join(__dirname, '..', 'backups');
    const filePath = path.join(backupDir, fileName);
    
    // Validate filename format
    if (!fileName.match(/^cloud_prepper_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql$/)) {
      return res.status(400).json({ success: false, error: 'Invalid filename format' });
    }
    
    _logger.info('Admin starting database restore', { 
      adminId: req.user.id, 
      adminUsername: req.user.username, 
      fileName: fileName 
    });
    
    const sqlContent = await fs.readFile(filePath, 'utf8');

    console.log('Starting database restore...');
    console.log('⚠️  WARNING: This will completely replace your current database!');

    // Execute the SQL script
    const dbPool = getPool();
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');

      // Split SQL commands and execute them
      const commands = sqlContent
        .split('\n')
        .filter(line => line.trim() && !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .filter(cmd => cmd.trim());

      let executedCommands = 0;
      for (const command of commands) {
        if (command.trim()) {
          await client.query(command);
          executedCommands++;
        }
      }

      await client.query('COMMIT');

      _logger.info('Database restore completed successfully', { 
        fileName: fileName, 
        commandsExecuted: executedCommands,
        adminId: req.user.id 
      });

      res.json({
        success: true,
        message: 'Database restored successfully',
        commandsExecuted: executedCommands,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    _logger.error('Database restore failed', { 
      error: error.message, 
      fileName: req.body.fileName,
      adminId: req.user.id 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to restore database',
      details: error.message
    });
  }
});

// Helper function to generate complete backup script
async function generateCompleteBackupScript() {
  let script = '';

  // Add header
  script += `-- CompTIA Prepper Database Backup\n`;
  script += `-- Generated on: ${new Date().toISOString()}\n`;
  script += `-- Database: cloud_prepper\n\n`;

  script += `-- Disable foreign key checks and notifications\n`;
  script += `SET session_replication_role = replica;\n`;
  script += `SET client_min_messages = warning;\n\n`;

  // Generate schema creation
  script += await generateSchemaScript();

  // Generate table creation scripts
  script += await generateTableCreationScript();

  // Generate sequences and indexes
  script += await generateSequencesScript();
  script += await generateIndexesScript();

  // Generate data insertion scripts
  script += await generateDataScript();

  // Generate constraints and foreign keys
  script += await generateConstraintsScript();

  // Reset settings
  script += `\n-- Re-enable foreign key checks\n`;
  script += `SET session_replication_role = DEFAULT;\n`;
  script += `-- Backup completed\n`;

  return script;
}

// Generate schema creation script
async function generateSchemaScript() {
  const dbPool = getPool();
  const result = await dbPool.query(`
        SELECT schema_name 
        FROM information_schema.schemata 
        WHERE schema_name IN ('prepper', 'config', 'lasertg')
        ORDER BY schema_name
    `);

  let script = `-- Create schemas\n`;
  for (const row of result.rows) {
    script += `CREATE SCHEMA IF NOT EXISTS ${row.schema_name};\n`;
  }
  script += '\n';

  return script;
}

// Generate table creation script
async function generateTableCreationScript() {
  const dbPool = getPool();
  const tablesQuery = await dbPool.query(`
        SELECT schemaname, tablename 
        FROM pg_tables 
        WHERE schemaname IN ('prepper', 'config', 'lasertg')
        ORDER BY schemaname, tablename
    `);

  let script = `-- Create tables\n\n`;

  for (const table of tablesQuery.rows) {
    const tableName = `${table.schemaname}.${table.tablename}`;

    // Get table structure
    const structureResult = await dbPool.query(`
            SELECT column_name, data_type, character_maximum_length, 
                   column_default, is_nullable, numeric_precision, numeric_scale
            FROM information_schema.columns 
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
        `, [table.schemaname, table.tablename]);

    script += `-- Table: ${tableName}\n`;
    script += `DROP TABLE IF EXISTS ${tableName} CASCADE;\n`;
    script += `CREATE TABLE ${tableName} (\n`;

    const columns = structureResult.rows.map(col => {
      let colDef = `    ${col.column_name} `;

      // Handle data types
      if (col.data_type === 'character varying' && col.character_maximum_length) {
        colDef += `VARCHAR(${col.character_maximum_length})`;
      } else if (col.data_type === 'numeric' && col.numeric_precision) {
        colDef += `NUMERIC(${col.numeric_precision}${col.numeric_scale ? ',' + col.numeric_scale : ''})`;
      } else if (col.data_type === 'USER-DEFINED') {
        colDef += 'JSONB';
      } else {
        colDef += col.data_type.toUpperCase();
      }

      // Handle nullable
      if (col.is_nullable === 'NO') {
        colDef += ' NOT NULL';
      }

      // Handle defaults
      if (col.column_default) {
        colDef += ` DEFAULT ${col.column_default}`;
      }

      return colDef;
    });

    script += columns.join(',\n');
    script += `\n);\n\n`;
  }

  return script;
}

// Generate sequences script
async function generateSequencesScript() {
  const dbPool = getPool();
  const sequencesQuery = await dbPool.query(`
        SELECT schemaname, sequencename 
        FROM pg_sequences 
        WHERE schemaname IN ('prepper', 'config', 'lasertg')
    `);

  let script = `-- Create sequences\n\n`;

  for (const seq of sequencesQuery.rows) {
    const seqName = `${seq.schemaname}.${seq.sequencename}`;

    const currentVal = await dbPool.query(`SELECT last_value FROM ${seqName}`);
    const lastValue = currentVal.rows[0]?.last_value || 1;

    script += `CREATE SEQUENCE IF NOT EXISTS ${seqName} START WITH ${lastValue + 1};\n`;
  }

  script += '\n';
  return script;
}

// Generate indexes script
async function generateIndexesScript() {
  const dbPool = getPool();
  const indexesQuery = await dbPool.query(`
        SELECT schemaname, tablename, indexname, indexdef
        FROM pg_indexes 
        WHERE schemaname IN ('prepper', 'config', 'lasertg')
        AND indexname NOT LIKE '%_pkey'
        ORDER BY schemaname, tablename, indexname
    `);

  let script = `-- Create indexes\n\n`;

  for (const idx of indexesQuery.rows) {
    script += `${idx.indexdef};\n`;
  }

  script += '\n';
  return script;
}

// Generate data insertion script
async function generateDataScript() {
  const dbPool = getPool();
  const tablesQuery = await dbPool.query(`
        SELECT schemaname, tablename 
        FROM pg_tables 
        WHERE schemaname IN ('prepper', 'config', 'lasertg')
        ORDER BY schemaname, tablename
    `);

  let script = `-- Insert data\n\n`;

  for (const table of tablesQuery.rows) {
    const tableName = `${table.schemaname}.${table.tablename}`;

    // Get column names
    const columnsResult = await dbPool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
        `, [table.schemaname, table.tablename]);

    const columnNames = columnsResult.rows.map(col => col.column_name);

    // Get data
    const dataResult = await dbPool.query(`SELECT * FROM ${tableName} ORDER BY 1`);

    if (dataResult.rows.length > 0) {
      script += `-- Data for table: ${tableName}\n`;

      for (const row of dataResult.rows) {
        const values = columnNames.map(colName => {
          const value = row[colName];
          if (value === null) return 'NULL';
          if (typeof value === 'string') {
            return `'${value.replace(/'/g, "''")}'`;
          }
          if (typeof value === 'object') {
            return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
          }
          return value;
        });

        script += `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
      script += '\n';
    }
  }

  return script;
}

// Generate constraints script
async function generateConstraintsScript() {
  const dbPool = getPool();
  const constraintsQuery = await dbPool.query(`
        SELECT 
            tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type,
            pg_get_constraintdef(pgc.oid) as constraint_definition
        FROM information_schema.table_constraints tc
        JOIN pg_constraint pgc ON tc.constraint_name = pgc.conname
        WHERE tc.table_schema IN ('prepper', 'config', 'lasertg')
        AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE', 'CHECK')
        ORDER BY tc.table_schema, tc.table_name, tc.constraint_type
    `);

  let script = `-- Add constraints\n\n`;

  for (const constraint of constraintsQuery.rows) {
    const tableName = `${constraint.table_schema}.${constraint.table_name}`;
    script += `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraint.constraint_name} ${constraint.constraint_definition};\n`;
  }

  script += '\n';
  return script;
}

// Get table counts for backup summary
async function getTableCounts() {
  const dbPool = getPool();
  const tablesQuery = await dbPool.query(`
        SELECT schemaname, tablename 
        FROM pg_tables 
        WHERE schemaname IN ('prepper', 'config', 'lasertg')
        ORDER BY schemaname, tablename
    `);

  const tableCounts = {};

  for (const table of tablesQuery.rows) {
    const tableName = `${table.schemaname}.${table.tablename}`;
    const countResult = await dbPool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
    tableCounts[tableName] = parseInt(countResult.rows[0].count);
  }

  return tableCounts;
}

// Utility function to format bytes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = router;
