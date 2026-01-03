const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const logger = require('../logs/prepperLog');
const { connectLocalPostgres } = require('../documentdb/client');

const router = express.Router();
const _logger = logger();

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Batch API configuration
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const BATCH_ENDPOINT_PATH = process.env.CLAUDE_BATCHES_REL || '/v1/messages/batches';
// Construct full batch endpoint URL (handle both relative and absolute)
const getBatchUrl = (path = '') => {
  const basePath = BATCH_ENDPOINT_PATH.startsWith('http')
    ? BATCH_ENDPOINT_PATH
    : `${ANTHROPIC_BASE_URL}${BATCH_ENDPOINT_PATH}`;
  return path ? `${basePath}${path}` : basePath;
};
const BATCH_POLL_INTERVAL = parseInt(process.env.BATCH_POLL_INTERVAL) || 2000; // 2 seconds (configurable)
const BATCH_POLL_TIMEOUT = parseInt(process.env.BATCH_POLL_TIMEOUT) || 600000; // 10 minutes (configurable, increased from 5)
const BACKGROUND_POLL_INTERVAL = parseInt(process.env.BACKGROUND_POLL_INTERVAL) || 300000; // 5 minutes (configurable)

// Database connection (reused)
let dbClient = null;

/**
 * Get or create database connection
 */
async function getDbClient() {
  if (!dbClient || dbClient._ending) {
    dbClient = await connectLocalPostgres();
  }
  return dbClient;
}

/**
 * Generate a unique batch ID
 */
function generateBatchId() {
  return `batch_${Date.now()}_${uuidv4().substring(0, 8)}`;
}

/**
 * Store batch job in database
 */
async function storeBatchJob(batchData) {
  const client = await getDbClient();
  const {
    batch_id,
    anthropic_batch_id,
    user_id,
    username,
    certification_type,
    domain_name,
    cognitive_level,
    skill_level,
    count,
    scenario_context,
    request_params,
  } = batchData;

  // Validate and convert user_id to integer or null
  // Handle cases where user_id might be a string like "cloudprepper-mcp" or other non-integer values
  let validatedUserId = null;
  if (user_id != null && user_id !== undefined && user_id !== '') {
    if (typeof user_id === 'number') {
      // Already a number - validate it's a positive integer
      if (Number.isInteger(user_id) && user_id > 0) {
        validatedUserId = user_id;
      }
    } else if (typeof user_id === 'string') {
      // Try to parse string to integer
      const parsedId = parseInt(user_id, 10);
      if (!isNaN(parsedId) && Number.isInteger(parsedId) && parsedId > 0) {
        validatedUserId = parsedId;
      } else {
        // String cannot be converted to valid integer - log and set to null
        _logger.warn('Invalid user_id format, setting to null', {
          user_id,
          username,
          batch_id,
        });
      }
    }
  }

  const query = `
    INSERT INTO prepper.batch_jobs (
      batch_id, anthropic_batch_id, status, user_id, username,
      certification_type, domain_name, cognitive_level, skill_level,
      count, scenario_context, request_params, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
    RETURNING *
  `;

  const values = [
    batch_id,
    anthropic_batch_id,
    'pending',
    validatedUserId,
    username || null,
    certification_type || null,
    domain_name || null,
    cognitive_level || null,
    skill_level || null,
    count || null,
    scenario_context || null,
    request_params ? JSON.stringify(request_params) : null,
  ];

  const result = await client.query(query, values);
  return result.rows[0];
}

/**
 * Update batch job status in database
 */
async function updateBatchJobStatus(batchId, updates) {
  const client = await getDbClient();
  const updateFields = [];
  const values = [];
  let paramIndex = 1;

  if (updates.status) {
    updateFields.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.results !== undefined) {
    updateFields.push(`results = $${paramIndex++}`);
    values.push(JSON.stringify(updates.results));
  }
  if (updates.error_message) {
    updateFields.push(`error_message = $${paramIndex++}`);
    values.push(updates.error_message);
  }
  if (updates.completed_at !== undefined) {
    updateFields.push(`completed_at = $${paramIndex++}`);
    values.push(updates.completed_at);
  }

  updateFields.push(`last_polled_at = NOW()`);
  updateFields.push(`updated_at = NOW()`);

  values.push(batchId);

  const query = `
    UPDATE prepper.batch_jobs
    SET ${updateFields.join(', ')}
    WHERE batch_id = $${paramIndex}
    RETURNING *
  `;

  const result = await client.query(query, values);
  return result.rows[0];
}

/**
 * Get batch job by batch_id
 */
async function getBatchJob(batchId) {
  const client = await getDbClient();
  const query = 'SELECT * FROM prepper.batch_jobs WHERE batch_id = $1';
  const result = await client.query(query, [batchId]);
  return result.rows[0];
}

/**
 * Get all pending/active batches for polling
 */
async function getPendingBatches() {
  const client = await getDbClient();
  const query = `
    SELECT * FROM prepper.batch_jobs
    WHERE status IN ('pending', 'validating', 'in_progress')
    ORDER BY created_at ASC
  `;
  const result = await client.query(query);
  return result.rows;
}

/**
 * @swagger
 * /questions/generate:
 *   post:
 *     summary: Generate certification exam questions using AI
 *     description: Uses Claude AI to generate high-quality, copyright-safe certification questions
 *     tags: [Questions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - certification_type
 *             properties:
 *               certification_type:
 *                 type: string
 *                 enum: [CV0-004, SAA-C03]
 *                 description: Target certification
 *               domain_name:
 *                 type: string
 *                 description: Specific domain to focus on (optional)
 *               cognitive_level:
 *                 type: string
 *                 enum: [Knowledge, Comprehension, Application, Analysis, Synthesis, Evaluation]
 *                 description: Bloom's taxonomy level (optional)
 *               skill_level:
 *                 type: string
 *                 enum: [Beginner, Intermediate, Advanced, Expert]
 *                 description: Target skill level (optional)
 *               count:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 default: 1
 *                 description: Number of questions to generate
 *               scenario_context:
 *                 type: string
 *                 description: Optional scenario context or specific requirements
 *     responses:
 *       200:
 *         description: Questions generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 questions:
 *                   type: array
 *                   items:
 *                     type: object
 *                 metadata:
 *                   type: object
 *       400:
 *         description: Bad request - Invalid parameters
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error - Question generation failed
 */
router.post('/generateQuestion', authenticateToken, async (req, res) => {
  try {
    const {
      certification_type,
      domain_name,
      cognitive_level,
      skill_level,
      count = 1,
      scenario_context,
    } = req.body;

    // Validate required fields
    if (!certification_type) {
      return res.status(400).json({
        success: false,
        error: 'certification_type is required',
      });
    }

    // Validate certification type
    if (!['CV0-004', 'SAA-C03'].includes(certification_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid certification_type. Must be CV0-004 or SAA-C03',
      });
    }

    // Validate count
    if (count < 1 || count > 10) {
      return res.status(400).json({
        success: false,
        error: 'count must be between 1 and 10',
      });
    }

    _logger.info(`Generating ${count} questions for ${certification_type}`, {
      user: req.user?.username,
      domain: domain_name,
      cognitive_level,
      skill_level,
    });

    // Build the prompt
    const prompt = buildGenerationPrompt({
      certification_type,
      domain_name,
      cognitive_level,
      skill_level,
      scenario_context,
      count,
    });

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      temperature: 1,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // Extract the response text
    const responseText = message.content[0].text;

    // Parse the JSON response
    let questions;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      questions = JSON.parse(jsonText);
    } catch (parseError) {
      _logger.error('Failed to parse Claude response as JSON', {
        error: parseError.message,
        response: responseText.substring(0, 500),
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to parse generated questions',
        details: parseError.message,
      });
    }

    // Validate questions structure
    if (!Array.isArray(questions)) {
      questions = [questions];
    }

    _logger.info(`Successfully generated ${questions.length} questions`);

    res.json({
      success: true,
      count: questions.length,
      questions: questions,
      metadata: {
        certification_type,
        domain_name,
        cognitive_level,
        skill_level,
        generated_at: new Date().toISOString(),
        generated_by: req.user?.username,
      },
    });
  } catch (error) {
    _logger.error('Question generation failed', {
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      success: false,
      error: 'Question generation failed',
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /questions/generateBatch:
 *   post:
 *     summary: Generate certification exam questions in batch using AI
 *     description: Uses Claude AI batch API to generate multiple high-quality, copyright-safe certification questions efficiently
 *     tags: [Questions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - certification_type
 *               - count
 *             properties:
 *               certification_type:
 *                 type: string
 *                 enum: [CV0-004, SAA-C03]
 *                 description: Target certification
 *               count:
 *                 type: integer
 *                 minimum: 1
 *                 description: Number of questions to generate (no maximum limit for testing)
 *               domain_name:
 *                 type: string
 *                 description: Specific domain to focus on (optional)
 *               cognitive_level:
 *                 type: string
 *                 enum: [Knowledge, Comprehension, Application, Analysis, Synthesis, Evaluation]
 *                 description: Bloom's taxonomy level (optional)
 *               skill_level:
 *                 type: string
 *                 enum: [Beginner, Intermediate, Advanced, Expert]
 *                 description: Target skill level (optional)
 *               scenario_context:
 *                 type: string
 *                 description: Optional scenario context or specific requirements
 *     responses:
 *       200:
 *         description: Batch submitted successfully (fire and forget)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 batch_id:
 *                   type: string
 *                 anthropic_batch_id:
 *                   type: string
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *                 metadata:
 *                   type: object
 *       400:
 *         description: Bad request - Invalid parameters
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error - Batch submission failed
 */
router.post('/generateBatch', authenticateToken, async (req, res) => {
  try {
    const {
      certification_type,
      domain_name,
      cognitive_level,
      skill_level,
      count,
      scenario_context,
    } = req.body;

    // Validate required fields
    if (!certification_type) {
      return res.status(400).json({
        success: false,
        error: 'certification_type is required',
      });
    }

    if (!count) {
      return res.status(400).json({
        success: false,
        error: 'count is required',
      });
    }

    // Validate certification type
    if (!['CV0-004', 'SAA-C03'].includes(certification_type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid certification_type. Must be CV0-004 or SAA-C03',
      });
    }

    // Validate count (allow any positive number for testing)
    if (count < 1) {
      return res.status(400).json({
        success: false,
        error: 'count must be at least 1',
      });
    }

    // Validate batch endpoint is configured
    if (!BATCH_ENDPOINT_PATH) {
      _logger.error('Batch endpoint not configured', {
        user: req.user?.username,
      });
      return res.status(500).json({
        success: false,
        error: 'Batch endpoint not configured',
      });
    }

    // Generate local batch ID
    const localBatchId = generateBatchId();

    _logger.info(`Submitting batch request for ${count} questions`, {
      user: req.user?.username,
      batch_id: localBatchId,
      certification_type,
      domain: domain_name,
      cognitive_level,
      skill_level,
      count,
    });

    // Create batch request with individual message requests
    const batchRequests = [];
    for (let i = 0; i < count; i++) {
      const prompt = buildGenerationPrompt({
        certification_type,
        domain_name,
        cognitive_level,
        skill_level,
        scenario_context,
        count: 1, // Each request generates 1 question
      });

      batchRequests.push({
        custom_id: `question_${i + 1}_${Date.now()}_${localBatchId}`,
        params: {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          temperature: 1,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        },
      });
    }

    // Submit batch to Anthropic API
    const anthropicBatchId = await submitBatchRequest(batchRequests);

    _logger.info('Batch submitted to Anthropic API', {
      batch_id: localBatchId,
      anthropic_batch_id: anthropicBatchId,
      request_count: count ?? 0,
    });

    // Store batch job in database
    const batchJob = await storeBatchJob({
      batch_id: localBatchId,
      anthropic_batch_id: anthropicBatchId,
      user_id: req.user?.id,
      username: req.user?.username,
      certification_type,
      domain_name,
      cognitive_level,
      skill_level,
      count,
      scenario_context,
      request_params: {
        certification_type,
        domain_name,
        cognitive_level,
        skill_level,
        count,
        scenario_context,
      },
    });

    _logger.info('Batch job stored in database', {
      batch_id: localBatchId,
      db_id: batchJob.id,
    });

    // Return immediately with batch ID (fire and forget)
    res.json({
      success: true,
      batch_id: localBatchId,
      anthropic_batch_id: anthropicBatchId,
      status: 'pending',
      message: 'Batch submitted successfully. Use batch_id to check status and retrieve results when ready.',
      metadata: {
        certification_type,
        domain_name,
        cognitive_level,
        skill_level,
        count,
        submitted_at: new Date().toISOString(),
        submitted_by: req.user?.username,
      },
    });
  } catch (error) {
    _logger.error('Batch submission failed', {
      error: error.message,
      stack: error.stack,
      user: req.user?.username,
    });

    res.status(500).json({
      success: false,
      error: 'Batch submission failed',
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /questions/batch/{batchId}/status:
 *   get:
 *     summary: Get batch job status
 *     description: Retrieve the current status of a batch job from the database
 *     tags: [Questions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema:
 *           type: string
 *         description: The batch ID returned from generateBatch
 *     responses:
 *       200:
 *         description: Batch status retrieved successfully
 *       404:
 *         description: Batch not found
 *       401:
 *         description: Unauthorized
 */
router.get('/batch/:batchId/status', authenticateToken, async (req, res) => {
  try {
    const { batchId } = req.params;

    const batchJob = await getBatchJob(batchId);

    if (!batchJob) {
      return res.status(404).json({
        success: false,
        error: 'Batch not found',
        batch_id: batchId,
      });
    }

    // Parse JSON fields
    const requestParams = batchJob.request_params
      ? JSON.parse(batchJob.request_params)
      : null;

    res.json({
      success: true,
      batch_id: batchJob.batch_id,
      anthropic_batch_id: batchJob.anthropic_batch_id,
      status: batchJob.status,
      progress: {
        // Note: We'll update this when we implement background polling
        total: batchJob.count || 0,
      },
      metadata: {
        certification_type: batchJob.certification_type,
        domain_name: batchJob.domain_name,
        cognitive_level: batchJob.cognitive_level,
        skill_level: batchJob.skill_level,
        count: batchJob.count,
        created_at: batchJob.created_at,
        updated_at: batchJob.updated_at,
        last_polled_at: batchJob.last_polled_at,
        completed_at: batchJob.completed_at,
      },
      error_message: batchJob.error_message || null,
    });
  } catch (error) {
    _logger.error('Error retrieving batch status', {
      error: error.message,
      stack: error.stack,
      batch_id: req.params.batchId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve batch status',
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /questions/batch/{batchId}/results:
 *   get:
 *     summary: Get batch job results
 *     description: Retrieve completed batch results from the database
 *     tags: [Questions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema:
 *           type: string
 *         description: The batch ID returned from generateBatch
 *     responses:
 *       200:
 *         description: Batch results retrieved successfully
 *       404:
 *         description: Batch not found or not completed
 *       401:
 *         description: Unauthorized
 */
router.get('/batch/:batchId/results', authenticateToken, async (req, res) => {
  try {
    const { batchId } = req.params;

    const batchJob = await getBatchJob(batchId);

    if (!batchJob) {
      return res.status(404).json({
        success: false,
        error: 'Batch not found',
        batch_id: batchId,
      });
    }

    if (batchJob.status !== 'completed') {
      return res.status(404).json({
        success: false,
        error: `Batch is not completed. Current status: ${batchJob.status}`,
        batch_id: batchId,
        status: batchJob.status,
        message: 'Use the status endpoint to check batch progress',
      });
    }

    // Parse results from JSONB
    let questions = [];
    if (batchJob.results) {
      try {
        const resultsData =
          typeof batchJob.results === 'string'
            ? JSON.parse(batchJob.results)
            : batchJob.results;
        questions = Array.isArray(resultsData) ? resultsData : [resultsData];
      } catch (parseError) {
        _logger.error('Error parsing batch results', {
          batch_id: batchId,
          error: parseError.message,
        });
      }
    }

    res.json({
      success: true,
      batch_id: batchJob.batch_id,
      status: batchJob.status,
      count: questions.length,
      questions: questions,
      metadata: {
        certification_type: batchJob.certification_type,
        domain_name: batchJob.domain_name,
        cognitive_level: batchJob.cognitive_level,
        skill_level: batchJob.skill_level,
        completed_at: batchJob.completed_at,
        generated_by: batchJob.username,
      },
    });
  } catch (error) {
    _logger.error('Error retrieving batch results', {
      error: error.message,
      stack: error.stack,
      batch_id: req.params.batchId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve batch results',
      details: error.message,
    });
  }
});

/**
 * Submit a batch request to Anthropic API
 */
async function submitBatchRequest(requests) {
  const url = getBatchUrl();

  _logger.info('Submitting batch request to Anthropic API', {
    url,
    request_count: requests.length,
  });

  try {
    const response = await axios.post(
      url,
      {
        requests: requests,
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data || !response.data.id) {
      throw new Error('Invalid batch response: missing batch ID');
    }

    return response.data.id;
  } catch (error) {
    _logger.error('Failed to submit batch request', {
      error: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
    });
    throw new Error(`Batch submission failed: ${error.message}`);
  }
}

/**
 * Poll batch status from Anthropic API (used by background job)
 */
async function pollBatchStatusFromAPI(anthropicBatchId) {
  const url = getBatchUrl(`/${anthropicBatchId}`);
  const startTime = Date.now();

  try {
    const response = await axios.get(url, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });

    return response.data;
  } catch (error) {
    _logger.error('Error polling batch status from API', {
      anthropic_batch_id: anthropicBatchId,
      error: error.message,
      status: error.response?.status,
    });
    throw error;
  }
}

/**
 * Retrieve and parse batch results from Anthropic API
 */
async function retrieveBatchResultsFromAPI(anthropicBatchId) {
  const url = getBatchUrl(`/${anthropicBatchId}/results`);
  const allQuestions = [];

  _logger.info('Retrieving batch results from API', {
    anthropic_batch_id: anthropicBatchId,
  });

  try {
    const response = await axios.get(url, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });

    const results = response.data.results || [];

    _logger.info('Processing batch results', {
      anthropic_batch_id: anthropicBatchId,
      result_count: results.length,
    });

    for (const result of results) {
      if (result.error) {
        _logger.warn('Batch result contains error', {
          anthropic_batch_id: anthropicBatchId,
          custom_id: result.custom_id,
          error: result.error,
        });
        continue;
      }

      try {
        // Extract response text from result
        const responseText = result.response?.content?.[0]?.text;
        if (!responseText) {
          _logger.warn('Batch result missing response text', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
          });
          continue;
        }

        // Parse JSON from response
        let questions;
        try {
          const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
          const jsonText = jsonMatch ? jsonMatch[1] : responseText;
          questions = JSON.parse(jsonText);
        } catch (parseError) {
          _logger.error('Failed to parse batch result as JSON', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
            error: parseError.message,
            response_preview: responseText.substring(0, 500),
          });
          continue;
        }

        // Validate and add questions
        if (Array.isArray(questions)) {
          allQuestions.push(...questions);
        } else if (questions && typeof questions === 'object') {
          allQuestions.push(questions);
        }
      } catch (error) {
        _logger.error('Error processing batch result', {
          anthropic_batch_id: anthropicBatchId,
          custom_id: result.custom_id,
          error: error.message,
        });
      }
    }

    _logger.info('Successfully processed batch results', {
      anthropic_batch_id: anthropicBatchId,
      total_questions: allQuestions.length,
    });

    return allQuestions;
  } catch (error) {
    _logger.error('Failed to retrieve batch results from API', {
      anthropic_batch_id: anthropicBatchId,
      error: error.message,
      status: error.response?.status,
    });
    throw new Error(`Failed to retrieve batch results: ${error.message}`);
  }
}

/**
 * Background polling job - polls pending batches and updates database
 */
async function pollPendingBatches() {
  try {
    const pendingBatches = await getPendingBatches();

    if (pendingBatches.length === 0) {
      return; // No batches to poll
    }

    _logger.info(`Polling ${pendingBatches.length} pending batch(es)`);

    for (const batchJob of pendingBatches) {
      try {
        // Poll Anthropic API for status
        const batchStatus = await pollBatchStatusFromAPI(
          batchJob.anthropic_batch_id
        );

        const status = batchStatus.status;
        const updates = {
          status: status,
        };

        _logger.info('Batch status update', {
          batch_id: batchJob.batch_id,
          anthropic_batch_id: batchJob.anthropic_batch_id,
          status,
          processed_count: batchStatus.processed_count,
          total_count: batchStatus.total_count,
        });

        // If batch is completed, retrieve and store results
        if (status === 'completed') {
          try {
            const allQuestions = await retrieveBatchResultsFromAPI(
              batchJob.anthropic_batch_id
            );

            updates.results = allQuestions;
            updates.completed_at = new Date().toISOString();

            _logger.info('Batch completed, results stored', {
              batch_id: batchJob.batch_id,
              question_count: allQuestions.length,
            });
          } catch (resultError) {
            _logger.error('Failed to retrieve batch results', {
              batch_id: batchJob.batch_id,
              error: resultError.message,
            });
            updates.error_message = `Failed to retrieve results: ${resultError.message}`;
          }
        } else if (['expired', 'cancelled'].includes(status)) {
          updates.error_message =
            batchStatus.error?.message || `Batch ${status}`;
          updates.completed_at = new Date().toISOString();
        }

        // Update database
        await updateBatchJobStatus(batchJob.batch_id, updates);
      } catch (error) {
        _logger.error('Error polling batch', {
          batch_id: batchJob.batch_id,
          anthropic_batch_id: batchJob.anthropic_batch_id,
          error: error.message,
        });

        // Update with error status
        await updateBatchJobStatus(batchJob.batch_id, {
          status: 'error',
          error_message: error.message,
        });
      }
    }
  } catch (error) {
    _logger.error('Error in background polling job', {
      error: error.message,
      stack: error.stack,
    });
  }
}

/**
 * Start background polling interval
 */
function startBackgroundPolling() {
  _logger.info('Starting background batch polling', {
    interval_ms: BACKGROUND_POLL_INTERVAL,
    interval_minutes: BACKGROUND_POLL_INTERVAL / 60000,
  });

  // Poll immediately on startup
  pollPendingBatches().catch((error) => {
    _logger.error('Error in initial background poll', {
      error: error.message,
    });
  });

  // Then poll at intervals
  setInterval(() => {
    pollPendingBatches().catch((error) => {
      _logger.error('Error in background polling interval', {
        error: error.message,
      });
    });
  }, BACKGROUND_POLL_INTERVAL);
}

/**
 * Build the generation prompt for Claude
 */
function buildGenerationPrompt(params) {
  const {
    certification_type,
    domain_name,
    cognitive_level,
    skill_level,
    scenario_context,
    count,
  } = params;

  const currentYear = new Date().getFullYear();

  let prompt = `You are an expert certification exam question writer for ${certification_type}.

CRITICAL REQUIREMENTS:
1. NEVER copy or paraphrase existing exam questions
2. Create original scenarios based on real-world ${currentYear} cloud architectures
3. Questions must test practical application, not memorization
4. Use current AWS/cloud services and best practices
5. Provide detailed explanations with technical reasoning

`;

  if (domain_name) {
    prompt += `DOMAIN FOCUS: ${domain_name}\n`;
  }

  if (cognitive_level) {
    prompt += `COGNITIVE LEVEL: ${cognitive_level} (Bloom's Taxonomy)\n`;
  }

  if (skill_level) {
    prompt += `SKILL LEVEL: ${skill_level}\n`;
  }

  if (scenario_context) {
    prompt += `SCENARIO CONTEXT: ${scenario_context}\n`;
  }

  prompt += `
QUESTION STRUCTURE:
1. Start with a realistic business scenario
2. Include relevant technical constraints
3. Present 4-5 plausible options (all within same domain)
4. Mark correct answer(s)
5. Provide comprehensive explanation with:
   - Why correct answer(s) are right
   - Why other options are wrong
   - Technical implementation details
   - Real-world considerations

AVOID:
- Generic placeholder distractors like "Outdated legacy method"
- Obviously wrong answers
- Options from completely different domains
- Surface-level explanations

Generate ${count} question(s) and return ONLY a JSON array with this exact structure:

[
  {
    "question_text": "Complete question text with scenario",
    "options": [
      "Option A text",
      "Option B text",
      "Option C text",
      "Option D text"
    ],
    "correct_answers": [1],
    "explanation": "Comprehensive explanation...",
    "domain": "${domain_name || 'Appropriate domain'}",
    "subdomain": "Appropriate subdomain",
    "cognitive_level": "${cognitive_level || 'Application'}",
    "skill_level": "${skill_level || 'Intermediate'}",
    "tags": ["tag1", "tag2", "tag3"],
    "references": ["Reference 1", "Reference 2"]
  }
]

Return ONLY valid JSON with no additional text or markdown.`;

  return prompt;
}

module.exports = router;
module.exports.startBackgroundPolling = startBackgroundPolling;