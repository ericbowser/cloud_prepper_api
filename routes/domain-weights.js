const express = require('express');
const { connectLocalPostgres } = require('../documentdb/client');
const logger = require('../logs/prepperLog');

const router = express.Router();
const _logger = logger();

let dbClient = null;

async function getDbClient() {
  if (!dbClient || dbClient._ending) {
    dbClient = await connectLocalPostgres();
    return dbClient;
  }
  
  try {
    await dbClient.query('SELECT 1');
  } catch (error) {
    _logger.warn('Database connection test failed, reconnecting', {
      error: error.message,
    });
    dbClient = null;
    dbClient = await connectLocalPostgres();
  }
  
  return dbClient;
}

/**
 * @swagger
 * /domain-weights:
 *   get:
 *     summary: Get domain weights for specific certification from database
 *     description: Returns domain weights from database (single source of truth)
 *     tags: [Domain Weights]
 *     parameters:
 *       - in: query
 *         name: certification_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [CV0-004, SAA-C03]
 *         description: Certification type
 *     responses:
 *       200:
 *         description: Domain weights retrieved successfully
 *       400:
 *         description: Missing certification_type parameter
 *       500:
 *         description: Server error
 */
router.get('/', async (req, res) => {
  try {
    const { certification_type } = req.query;
    
    if (!certification_type) {
      return res.status(400).json({
        success: false,
        error: 'certification_type is required'
      });
    }
    
    const client = await getDbClient();
    
    // Query domain weights from database
    // Table name: prepper.domain_weight_cv0_004 or similar
    let query;
    let tableName;
    
    if (certification_type === 'CV0-004') {
      tableName = 'prepper.domain_weight_cv0_004';
    } else if (certification_type === 'SAA-C03') {
      tableName = 'prepper.domain_weight_saa_c03';
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid certification_type. Must be CV0-004 or SAA-C03'
      });
    }
    
    query = `
      SELECT domain, weight
      FROM ${tableName}
      ORDER BY weight DESC
    `;
    
    _logger.info('Fetching domain weights from database', {
      certification_type,
      table_name: tableName
    });
    
    const result = await client.query(query);
    
    // Format response
    const weights = result.rows.map(row => ({
      domain: row.domain,
      weight: parseInt(row.weight, 10)
    }));
    
    // Calculate total to verify 100%
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    
    _logger.info('Domain weights retrieved successfully', {
      certification_type,
      domain_count: weights.length,
      total_weight: total
    });
    
    res.json({
      success: true,
      data: weights,
      metadata: {
        certification_type,
        domain_count: weights.length,
        total_weight: total,
        fetched_at: new Date().toISOString()
      }
    });
    
  } catch (error) {
    _logger.error('Error fetching domain weights', {
      error: error.message,
      stack: error.stack,
      certification_type: req.query.certification_type
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch domain weights',
      details: error.message
    });
  }
});

/**
 * @swagger
 * /domain-weights/map:
 *   get:
 *     summary: Get domain weights as key-value map
 *     description: Returns {domain_name: weight} for easy lookup
 *     tags: [Domain Weights]
 *     parameters:
 *       - in: query
 *         name: certification_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [CV0-004, SAA-C03]
 *     responses:
 *       200:
 *         description: Domain weight map retrieved
 */
router.get('/map', async (req, res) => {
  try {
    const { certification_type } = req.query;
    
    if (!certification_type) {
      return res.status(400).json({
        success: false,
        error: 'certification_type is required'
      });
    }
    
    const client = await getDbClient();
    
    let tableName;
    if (certification_type === 'CV0-004') {
      tableName = 'prepper.domain_weight_cv0_004';
    } else if (certification_type === 'SAA-C03') {
      tableName = 'prepper.domain_weight_saa_c03';
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid certification_type'
      });
    }
    
    const query = `SELECT domain, weight FROM ${tableName}`;
    const result = await client.query(query);
    
    // Convert to simple map: {domain_name: weight}
    const weightMap = {};
    result.rows.forEach(row => {
      weightMap[row.domain] = parseInt(row.weight, 10);
    });
    
    res.json({
      success: true,
      data: weightMap,
      metadata: {
        certification_type,
        domain_count: result.rows.length
      }
    });
    
  } catch (error) {
    _logger.error('Error fetching domain weight map', {
      error: error.message,
      certification_type: req.query.certification_type
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch domain weight map',
      details: error.message
    });
  }
});

module.exports = router;
