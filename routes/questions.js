const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const logger = require('../logs/prepperLog');

const router = express.Router();
const _logger = logger();

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
