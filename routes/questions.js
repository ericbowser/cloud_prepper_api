const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const logger = require('../logs/prepperLog');

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
const BATCH_POLL_INTERVAL = 2000; // 2 seconds
const BATCH_POLL_TIMEOUT = 300000; // 5 minutes

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
 *                   properties:
 *                     certification_type:
 *                       type: string
 *                     batch_id:
 *                       type: string
 *                     generated_at:
 *                       type: string
 *                     generated_by:
 *                       type: string
 *       400:
 *         description: Bad request - Invalid parameters
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error - Batch generation failed
 *       504:
 *         description: Gateway timeout - Batch processing exceeded timeout
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

    _logger.info(`Submitting batch request for ${count} questions`, {
      user: req.user?.username,
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
        custom_id: `question_${i + 1}_${Date.now()}`,
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

    // Submit batch
    const batchId = await submitBatchRequest(batchRequests);

    _logger.info('Batch submitted successfully', {
      batch_id: batchId,
      request_count: count,
    });

    // Poll for batch completion
    const batchStatus = await pollBatchStatus(batchId);

    if (batchStatus.status !== 'completed') {
      _logger.error('Batch did not complete successfully', {
        batch_id: batchId,
        status: batchStatus.status,
      });
      return res.status(500).json({
        success: false,
        error: `Batch processing failed with status: ${batchStatus.status}`,
        batch_id: batchId,
      });
    }

    // Retrieve and parse results
    const allQuestions = await retrieveBatchResults(batchId, batchStatus);

    _logger.info(`Successfully generated ${allQuestions.length} questions from batch`, {
      batch_id: batchId,
      expected_count: count,
      actual_count: allQuestions.length,
    });

    res.json({
      success: true,
      count: allQuestions.length,
      questions: allQuestions,
      metadata: {
        certification_type,
        domain_name,
        cognitive_level,
        skill_level,
        batch_id: batchId,
        generated_at: new Date().toISOString(),
        generated_by: req.user?.username,
      },
    });
  } catch (error) {
    _logger.error('Batch question generation failed', {
      error: error.message,
      stack: error.stack,
      user: req.user?.username,
    });

    // Handle timeout specifically
    if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      return res.status(504).json({
        success: false,
        error: 'Batch processing timeout - batch may still be processing',
        details: error.message,
      });
    }

    res.status(500).json({
      success: false,
      error: 'Batch question generation failed',
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
 * Poll batch status until completion or timeout
 */
async function pollBatchStatus(batchId) {
  const url = getBatchUrl(`/${batchId}`);
  const startTime = Date.now();

  _logger.info('Starting batch status polling', {
    batch_id: batchId,
    poll_interval: BATCH_POLL_INTERVAL,
    timeout: BATCH_POLL_TIMEOUT,
  });

  while (true) {
    // Check timeout
    if (Date.now() - startTime > BATCH_POLL_TIMEOUT) {
      _logger.error('Batch polling timeout', {
        batch_id: batchId,
        elapsed: Date.now() - startTime,
      });
      throw new Error('Batch processing timeout');
    }

    try {
      const response = await axios.get(url, {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      });

      const status = response.data.status;

      _logger.info('Batch status check', {
        batch_id: batchId,
        status,
        processed_count: response.data.processed_count,
        total_count: response.data.total_count,
      });

      // Check for terminal states
      if (status === 'completed') {
        return response.data;
      }

      if (['expired', 'cancelled'].includes(status)) {
        throw new Error(`Batch ${status}: ${response.data.error?.message || 'Unknown error'}`);
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL));
    } catch (error) {
      if (error.message.includes('timeout') || error.message.includes('Timeout')) {
        throw error;
      }

      _logger.error('Error polling batch status', {
        batch_id: batchId,
        error: error.message,
        status: error.response?.status,
      });

      // For non-timeout errors, wait and retry
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL));
    }
  }
}

/**
 * Retrieve and parse batch results
 */
async function retrieveBatchResults(batchId, batchStatus) {
  const url = getBatchUrl(`/${batchId}/results`);
  const allQuestions = [];

  _logger.info('Retrieving batch results', {
    batch_id: batchId,
    expected_results: batchStatus.total_count,
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
      batch_id: batchId,
      result_count: results.length,
    });

    for (const result of results) {
      if (result.error) {
        _logger.warn('Batch result contains error', {
          batch_id: batchId,
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
            batch_id: batchId,
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
            batch_id: batchId,
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
          batch_id: batchId,
          custom_id: result.custom_id,
          error: error.message,
        });
      }
    }

    _logger.info('Successfully processed batch results', {
      batch_id: batchId,
      total_questions: allQuestions.length,
    });

    return allQuestions;
  } catch (error) {
    _logger.error('Failed to retrieve batch results', {
      batch_id: batchId,
      error: error.message,
      status: error.response?.status,
    });
    throw new Error(`Failed to retrieve batch results: ${error.message}`);
  }
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
