const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const logger = require('../logs/prepperLog');
const { connectLocalPostgres } = require('../documentdb/client');
const { ANTHROPIC_BASE_URL, ANTHROPIC_BATCHES_REL, ANTHROPIC_API_KEY, CLAUDE_OPUS_4_5, CLAUDE_HAIKU_4_5} = require('dotenv').config().parsed;
const BATCH_POLL_INTERVAL = parseInt(process.env.BATCH_POLL_INTERVAL) || 2000; // 2 seconds (configurable)
const BATCH_POLL_TIMEOUT = parseInt(process.env.BATCH_POLL_TIMEOUT) || 600000; // 10 minutes (configurable, increased from 5)
const BACKGROUND_POLL_INTERVAL = parseInt(process.env.BACKGROUND_POLL_INTERVAL) || 300000; // 5 minutes (configurable)
const MAX_PENDING_AGE_HOURS = parseInt(process.env.MAX_PENDING_AGE_HOURS) || 24; // 24 hours (configurable)
const MAX_PENDING_AGE_MS = MAX_PENDING_AGE_HOURS * 60 * 60 * 1000;
const QUESTIONS_FOLDER = path.join(__dirname, '..', 'questions');
const DOMAIN_WEIGHTS = require('../utils/constants').DOMAIN_WEIGHTS;
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || ANTHROPIC_API_KEY,
});

// Database connection (reused)
let dbClient = null;

const router = express.Router();
const _logger = logger();

// Debug middleware to log all requests to questions router
router.use((req, res, next) => {
  next();
});

const _batchurl = `${ANTHROPIC_BASE_URL}${ANTHROPIC_BATCHES_REL}`;

async function getDbClient() {
  if (!dbClient || dbClient._ending) {
    _logger.info('[TRACE-DB] Creating new database connection', {
      has_existing_client: !!dbClient,
      existing_ending: dbClient?._ending,
    });
    dbClient = await connectLocalPostgres();
    return dbClient;
  }
  
  // Verify existing connection is still alive (only for reused connections)
  try {
    await dbClient.query('SELECT 1');
  } catch (error) {
    _logger.warn('[TRACE-DB] Database connection test failed, reconnecting', {
      error: error.message,
      error_code: error.code,
    });
    dbClient = null;
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
 * Ensure questions folder exists
 */
async function ensureQuestionsFolder() {
  try {
    await fs.access(QUESTIONS_FOLDER);
  } catch (error) {
    if (error.code === 'ENOENT') {
      _logger.info('[TRACE-FILE] Creating questions folder', {
        folder_path: QUESTIONS_FOLDER,
      });
      await fs.mkdir(QUESTIONS_FOLDER, { recursive: true });
    } else {
      throw error;
    }
  }
}

/**
 * Escape SQL string for INSERT statements
 */
function escapeSqlString(str) {
  if (str === null || str === undefined) {
    return 'NULL';
  }
  return "'" + String(str).replace(/'/g, "''") + "'";
}

/**
 * Convert question options array to SQL JSON format
 */
function formatOptionsForSql(options) {
  if (!Array.isArray(options)) {
    return 'NULL';
  }
  
  // Format as JSON array with text and isCorrect fields
  const formattedOptions = options.map((option, index) => {
    const optionText = typeof option === 'string' ? option : option.text || option;
    return {
      text: optionText,
      isCorrect: false // Will be set based on correct_answers
    };
  });
  
  // Mark correct answers
  // Note: correct_answers is an array of indices (0-based)
  return JSON.stringify(formattedOptions).replace(/'/g, "''");
}

/**
 * Determine table name based on certification type
 */
function getTableName(certificationType) {
  if (certificationType === 'CV0-004') {
    return 'prepper.comptia_cloud_plus_questions';
  } else if (certificationType === 'SAA-C03') {
    return 'prepper.aws_certified_architect_associate_questions';
  }
  // Default to CompTIA
  return 'prepper.comptia_cloud_plus_questions';
}

/**
 * Convert a single question to SQL INSERT statement
 */
function questionToSqlInsert(question, certificationType, index = 0) {
  const tableName = getTableName(certificationType);
  
  // Map fields from generated question to database schema
  const questionText = question.question_text || question.question || '';
  const options = question.options || [];
  const explanation = question.explanation || '';
  const domain = question.domain || '';
  const subdomain = question.subdomain || '';
  const cognitiveLevel = question.cognitive_level || '';
  const skillLevel = question.skill_level || '';
  
  // Extract correct_answers - can be array of indices or derive from isCorrect fields
  let correctAnswerIndices = [];
  if (Array.isArray(question.correct_answers)) {
    // Check if it's an array of indices (numbers) or strings
    if (question.correct_answers.length > 0 && typeof question.correct_answers[0] === 'number') {
      correctAnswerIndices = question.correct_answers;
    } else {
      // If it's strings, find the indices
      correctAnswerIndices = question.correct_answers
        .map(answerText => {
          const idx = options.findIndex(opt => {
            const optText = typeof opt === 'string' ? opt : opt.text || '';
            return optText === answerText;
          });
          return idx >= 0 ? idx : null;
        })
        .filter(idx => idx !== null);
    }
  }
  
  // If no correct_answers provided, derive from isCorrect fields in options
  if (correctAnswerIndices.length === 0) {
    options.forEach((option, idx) => {
      if (typeof option === 'object' && option.isCorrect === true) {
        correctAnswerIndices.push(idx);
      }
    });
  }
  
  // Format options - preserve isCorrect if present, otherwise create simple strings
  const formattedOptions = options.map((option) => {
    if (typeof option === 'string') {
      return option;
    } else if (typeof option === 'object' && option.text) {
      // Preserve isCorrect field if present
      if ('isCorrect' in option) {
        return { text: option.text, isCorrect: option.isCorrect === true };
      }
      return option.text;
    }
    return String(option);
  });
  
  // Determine correct answer text(s) from indices
  const correctAnswerTexts = correctAnswerIndices.map(idx => {
    if (idx >= 0 && idx < options.length) {
      const option = options[idx];
      return typeof option === 'string' ? option : option.text || option;
    }
    return '';
  }).filter(text => text.length > 0);
  
  // Primary correct answer (first one, or use correct_answer field if provided)
  const correctAnswer = question.correct_answer || (correctAnswerTexts.length > 0 ? correctAnswerTexts[0] : '');
  
  // Build explanation_details JSON - use the structure from Claude's response
  let explanationDetails;
  if (question.explanation_details &&
      question.explanation_details.summary &&
      question.explanation_details.breakdown &&
      question.explanation_details.otherOptions) {
    explanationDetails = {
      summary: question.explanation_details.summary,
      breakdown: question.explanation_details.breakdown,
      otherOptions: question.explanation_details.otherOptions
    };
  } else {
    explanationDetails = {
      summary: explanation ? explanation.split('.')[0] + '.' : 'No summary provided',
      breakdown: [],
      otherOptions: ''
    };
  }
  
  // Determine if multiple answers - explicit '1' means multiple, '0' or anything else means single
  // Also check if there are actually multiple correct answers by indices
  const isMultipleAnswers = question.multiple_answers === "1" || 
                           (question.multiple_answers !== "0" && correctAnswerIndices.length > 1);
  
  // Domain weight mapping
  const questionWeight = question.weight || domainWeights[domain] || 19;
  
  // Build INSERT statement
  let sqlContent = `INSERT INTO ${tableName}(\n`;
  sqlContent += `  id,\n`;
  sqlContent += `  question_id,\n`;
  sqlContent += `  question_number,\n`;
  sqlContent += `  category,\n`;
  sqlContent += `  domain,\n`;
  sqlContent += `  question_text,\n`;
  sqlContent += `  options,\n`;
  sqlContent += `  correct_answer,\n`;
  sqlContent += `  explanation,\n`;
  sqlContent += `  explanation_details,\n`;
  sqlContent += `  multiple_answers,\n`;
  sqlContent += `  correct_answers,\n`;
  sqlContent += `  cognitive_level,\n`;
  sqlContent += `  skill_level,\n`;
  sqlContent += `  weight,\n`;
  sqlContent += `  "references"\n`;
  sqlContent += `)\n`;
  sqlContent += `VALUES (\n`;
  
  // id - use nextval
  sqlContent += `  nextval('prepper.id_seq'),\n`;
  
  // question_id - use nextval
  sqlContent += `  nextval('prepper.question_id_seq'),\n`;
  
  // question_number - use nextval
  sqlContent += `  nextval('prepper.question_number_seq'),\n`;
  
  // category (use subdomain or domain)
  sqlContent += `  ${escapeSqlString(subdomain || domain || 'General')},\n`;
  
  // domain
  sqlContent += `  ${escapeSqlString(domain)},\n`;
  
  // question_text
  sqlContent += `  ${escapeSqlString(questionText)},\n`;
  
  // options (JSON array cast as jsonb)
  sqlContent += `  ${escapeSqlString(JSON.stringify(formattedOptions))}::jsonb,\n`;
  
  // correct_answer (NULL for multiple answers, text for single)
  if (isMultipleAnswers) {
    sqlContent += `  NULL,\n`;
  } else {
    sqlContent += `  ${escapeSqlString(correctAnswer)},\n`;
  }
  
  // explanation
  sqlContent += `  ${escapeSqlString(explanation)},\n`;
  
  // explanation_details (JSON object cast as jsonb)
  sqlContent += `  ${escapeSqlString(JSON.stringify(explanationDetails))}::jsonb,\n`;
  
  // multiple_answers (bit field: '0' for single answer, '1' for multiple answers)
  sqlContent += `  '${isMultipleAnswers ? '1' : '0'}',\n`;
  
  // correct_answers (ARRAY with answer texts)
  if (isMultipleAnswers && correctAnswerTexts.length > 0) {
    const answersArray = correctAnswerTexts.map(text => escapeSqlString(text)).join(', ');
    sqlContent += `  ARRAY[${answersArray}],\n`;
  } else {
    sqlContent += `  NULL,\n`;
  }
  
  // cognitive_level
  sqlContent += `  ${escapeSqlString(cognitiveLevel)},\n`;

  // skill_level
  sqlContent += `  ${escapeSqlString(skillLevel)},\n`;

  // weight
  sqlContent += `  ${questionWeight},\n`;

  // references (optional) - format as PostgreSQL text array
  if (question.references && Array.isArray(question.references) && question.references.length > 0) {
    const referencesArray = question.references.map(ref => escapeSqlString(ref)).join(', ');
    sqlContent += `  ARRAY[${referencesArray}]\n`;
  } else {
    sqlContent += `  NULL\n`;
  }

  sqlContent += `);\n\n`;
  
  return sqlContent;
}

/**
 * Convert questions array to SQL INSERT statements
 */
function questionsToSql(questions, certificationType) {
  let sqlContent = `-- Generated Questions SQL File\n`;
  sqlContent += `-- Generated: ${new Date().toISOString()}\n`;
  sqlContent += `-- Certification: ${certificationType}\n`;
  sqlContent += `-- Question Count: ${questions.length}\n\n`;
  
  const tableName = getTableName(certificationType);
  sqlContent += `-- Insert questions into ${tableName}\n\n`;
  
  questions.forEach((question, index) => {
    sqlContent += questionToSqlInsert(question, certificationType, index);
  });
  
  return sqlContent;
}

/**
 * Save batch results to SQL file
 */
async function saveBatchResultsToFile(batchId, questions, batchMetadata) {
  try {
    await ensureQuestionsFolder();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${batchId}_${timestamp}.sql`;
    const filepath = path.join(QUESTIONS_FOLDER, filename);
    
    const certificationType = batchMetadata?.certification_type || 'CV0-004';
    const tableName = getTableName(certificationType);
    
    // Build SQL file content
    let sqlContent = `-- Batch Questions SQL File\n`;
    sqlContent += `-- Generated: ${new Date().toISOString()}\n`;
    sqlContent += `-- Batch ID: ${batchId}\n`;
    sqlContent += `-- Certification: ${certificationType}\n`;
    sqlContent += `-- Question Count: ${questions.length}\n`;
    sqlContent += `-- Metadata: ${JSON.stringify(batchMetadata, null, 2)}\n\n`;
    
    sqlContent += `-- Insert questions into ${tableName}\n\n`;
    
    // Generate INSERT statement for each question
    questions.forEach((question, index) => {
      _logger.info('[TRACE-FILE] Processing question for SQL generation', {
        batch_id: batchId,
        question_index: index,
        has_question_text: !!(question.question_text || question.question),
        has_options: Array.isArray(question.options) && question.options.length > 0,
        options_count: question.options?.length || 0,
        has_correct_answers: Array.isArray(question.correct_answers) && question.correct_answers.length > 0,
        correct_answers_type: question.correct_answers?.[0] ? typeof question.correct_answers[0] : 'none',
        question_keys: Object.keys(question || {}),
      });
      
      // Map fields from generated question to database schema
      const questionText = question.question_text || question.question || '';
      const options = question.options || [];
      const explanation = question.explanation || '';
      const domain = question.domain || batchMetadata?.domain_name || '';
      const subdomain = question.subdomain || '';
      const cognitiveLevel = question.cognitive_level || batchMetadata?.cognitive_level || '';
      const skillLevel = question.skill_level || batchMetadata?.skill_level || '';
      
      // Extract correct_answers - can be array of indices or derive from isCorrect fields
      let correctAnswerIndices = [];
      if (Array.isArray(question.correct_answers)) {
        // Check if it's an array of indices (numbers) or strings
        if (question.correct_answers.length > 0 && typeof question.correct_answers[0] === 'number') {
          correctAnswerIndices = question.correct_answers;
        } else {
          // If it's strings, find the indices
          correctAnswerIndices = question.correct_answers
            .map(answerText => {
              const idx = options.findIndex(opt => {
                const optText = typeof opt === 'string' ? opt : opt.text || '';
                return optText === answerText;
              });
              return idx >= 0 ? idx : null;
            })
            .filter(idx => idx !== null);
        }
      }
      
      // If no correct_answers provided, derive from isCorrect fields in options
      if (correctAnswerIndices.length === 0) {
        options.forEach((option, idx) => {
          if (typeof option === 'object' && option.isCorrect === true) {
            correctAnswerIndices.push(idx);
          }
        });
      }
      
      // Format options - preserve isCorrect if present, otherwise create simple strings
      const formattedOptions = options.map((option) => {
        if (typeof option === 'string') {
          return option;
        } else if (typeof option === 'object' && option.text) {
          // Preserve isCorrect field if present
          if ('isCorrect' in option) {
            return { text: option.text, isCorrect: option.isCorrect === true };
          }
          return option.text;
        }
        return String(option);
      });
      
      // Determine correct answer text(s) from indices
      const correctAnswerTexts = correctAnswerIndices.map(idx => {
        if (idx >= 0 && idx < options.length) {
          const option = options[idx];
          return typeof option === 'string' ? option : option.text || option;
        }
        return '';
      }).filter(text => text.length > 0);
      
      // Determine if multiple answers - explicit '1' means multiple, '0' or anything else means single
      // Also check if there are actually multiple correct answers by indices
      const isMultipleAnswers = question.multiple_answers === "1" || 
                               (question.multiple_answers !== "0" && correctAnswerIndices.length > 1);
      
      // Primary correct answer (first one, or use correct_answer field if provided)
      // For multiple answer questions, correct_answer should be NULL
      const correctAnswer = isMultipleAnswers ? null : (question.correct_answer || (correctAnswerTexts.length > 0 ? correctAnswerTexts[0] : ''));
      
      _logger.info('[TRACE-FILE] Question processed, generating INSERT', {
        batch_id: batchId,
        question_index: index,
        question_text_length: questionText.length,
        options_count: formattedOptions.length,
        correct_answer_indices: correctAnswerIndices,
        correct_answer_texts_count: correctAnswerTexts.length,
        has_correct_answer: !!correctAnswer,
        is_multiple_answers: isMultipleAnswers,
        domain: domain,
        subdomain: subdomain,
      });
      
      // Build explanation_details JSON - use the structure from Claude's response
      // If question already has properly formatted explanation_details, use it
      // Otherwise, build a minimal structure
      let explanationDetails;
      if (question.explanation_details &&
          question.explanation_details.summary &&
          question.explanation_details.breakdown &&
          question.explanation_details.otherOptions) {
        // Use the properly formatted explanation_details from Claude
        explanationDetails = {
          summary: question.explanation_details.summary,
          breakdown: question.explanation_details.breakdown,
          otherOptions: question.explanation_details.otherOptions
        };
      } else {
        // Fallback: create minimal structure if not provided
        explanationDetails = {
          summary: explanation ? explanation.split('.')[0] + '.' : 'No summary provided',
          breakdown: [],
          otherOptions: ''
        };
      }
      
      // Build INSERT statement matching the exact format
      sqlContent += `INSERT INTO ${tableName}(\n`;
      sqlContent += `  id,\n`;
      sqlContent += `  question_id,\n`;
      sqlContent += `  question_number,\n`;
      sqlContent += `  category,\n`;
      sqlContent += `  domain,\n`;
      sqlContent += `  question_text,\n`;
      sqlContent += `  options,\n`;
      sqlContent += `  correct_answer,\n`;
      sqlContent += `  explanation,\n`;
      sqlContent += `  explanation_details,\n`;
      sqlContent += `  multiple_answers,\n`;
      sqlContent += `  correct_answers,\n`;
      sqlContent += `  cognitive_level,\n`;
      sqlContent += `  skill_level,\n`;
      sqlContent += `  weight,\n`;
      sqlContent += `  "references"\n`;
      sqlContent += `)\n`;
      sqlContent += `VALUES (\n`;
      
      // id - use nextval
      sqlContent += `  nextval('prepper.id_seq'),\n`;
      
      // question_id - use nextval
      sqlContent += `  nextval('prepper.question_id_seq'),\n`;
      
      // question_number - use nextval
      sqlContent += `  nextval('prepper.question_number_seq'),\n`;
      
      // category (use subdomain or domain)
      sqlContent += `  ${escapeSqlString(subdomain || domain || 'General')},\n`;
      
      // domain
      sqlContent += `  ${escapeSqlString(domain)},\n`;
      
      // question_text
      sqlContent += `  ${escapeSqlString(questionText)},\n`;
      
      // options (JSON array cast as jsonb)
      sqlContent += `  ${escapeSqlString(JSON.stringify(formattedOptions))}::jsonb,\n`;
      
      // correct_answer (NULL for multiple answers, text for single)
      if (isMultipleAnswers) {
        sqlContent += `  NULL,\n`;
      } else {
        sqlContent += `  ${escapeSqlString(correctAnswer)},\n`;
      }
      
      // explanation
      sqlContent += `  ${escapeSqlString(explanation)},\n`;
      
      // explanation_details (JSON object cast as jsonb)
      sqlContent += `  ${escapeSqlString(JSON.stringify(explanationDetails))}::jsonb,\n`;
      
      // multiple_answers (bit field: '0' for single answer, '1' for multiple answers)
      sqlContent += `  '${isMultipleAnswers ? '1' : '0'}',\n`;
      
      // correct_answers (ARRAY with answer texts)
      if (correctAnswerTexts.length > 0) {
        const answersArray = correctAnswerTexts.map(text => escapeSqlString(text)).join(', ');
        sqlContent += `  ARRAY[${answersArray}],\n`;
      } else {
        sqlContent += `  ARRAY[]::text[],\n`;
      }
      
      // cognitive_level
      sqlContent += `  ${escapeSqlString(cognitiveLevel)},\n`;

      // skill_level
      sqlContent += `  ${escapeSqlString(skillLevel)},\n`;

      // weight (get from question or use default based on domain)
      const domainWeights = {
        'Cloud Architecture and Design': 23,
        'Cloud Security': 19,
        'DevOps Fundamentals': 10,
        'Cloud Operations and Support': 17,
        'Cloud Deployment': 19,
        'Troubleshooting': 12,
      };
      const questionWeight = question.weight || domainWeights[domain] || 19;
      sqlContent += `  ${questionWeight},\n`;

      // references (optional) - format as PostgreSQL text array
      if (question.references && Array.isArray(question.references) && question.references.length > 0) {
        const referencesArray = question.references.map(ref => escapeSqlString(ref)).join(', ');
        sqlContent += `  ARRAY[${referencesArray}]\n`;
      } else {
        sqlContent += `  NULL\n`;
      }

      sqlContent += `);\n\n`;
    });
    
    await fs.writeFile(filepath, sqlContent, 'utf8');
    
    _logger.info('[TRACE-FILE] Batch results saved to SQL file', {
      batch_id: batchId,
      filepath: filepath,
      question_count: questions.length,
      table_name: tableName,
    });
    
    return filepath;
  } catch (error) {
    _logger.error('[TRACE-FILE-ERROR] Failed to save batch results to SQL file', {
      batch_id: batchId,
      error: error.message,
      error_code: error.code,
      error_stack: error.stack,
    });
    // Don't throw - file saving is non-critical, database storage is primary
    return null;
  }
}

/**
 * Store batch job in database
 */
async function storeBatchJob(batchData) {
  const startTime = Date.now();

  _logger.info('[TRACE-DB] Starting storeBatchJob', {
    batch_id: batchData.batch_id,
    anthropic_batch_id: batchData.anthropic_batch_id,
    user_id: batchData.user_id,
    username: batchData.username,
  });

  try {
    _logger.info('[TRACE-DB] Getting database client', {
      batch_id: batchData.batch_id,
    });

    const client = await getDbClient();

    _logger.info('[TRACE-DB] Database client obtained', {
      batch_id: batchData.batch_id,
      elapsed_ms: Date.now() - startTime,
    });

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
          _logger.warn('[TRACE-DB] Invalid user_id format, setting to null', {
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

    _logger.info('[TRACE-DB] Executing INSERT query', {
      batch_id,
      anthropic_batch_id,
      validated_user_id: validatedUserId,
      elapsed_ms: Date.now() - startTime,
    });

    const result = await client.query(query, values);

    _logger.info('[TRACE-DB] Batch job stored successfully', {
      batch_id,
      anthropic_batch_id,
      db_id: result.rows[0]?.id,
      elapsed_ms: Date.now() - startTime,
    });

    return result.rows[0];
  } catch (error) {
    _logger.error('[TRACE-DB-ERROR] Failed to store batch job', {
      batch_id: batchData.batch_id,
      anthropic_batch_id: batchData.anthropic_batch_id,
      error: error.message,
      error_code: error.code,
      stack: error.stack,
      elapsed_ms: Date.now() - startTime,
    });
    throw error;
  }
}

/**
 * Update batch job status in database
 */
async function updateBatchJobStatus(batchId, updates) {
  const startTime = Date.now();
  
  _logger.info('[TRACE-DB-UPDATE] Starting updateBatchJobStatus', {
    batch_id: batchId,
    updates: {
      status: updates.status,
      has_results: updates.results !== undefined,
      results_count: updates.results ? (Array.isArray(updates.results) ? updates.results.length : 1) : 0,
      error_message: updates.error_message,
      completed_at: updates.completed_at,
    },
  });

  try {
    let client = await getDbClient();
    // Verify client is valid
    if (!client) {
      throw new Error('Database client is null or undefined');
    }
    
    if (client._ending) {
      _logger.warn('[TRACE-DB-UPDATE] Database client is ending, reconnecting', { batch_id: batchId });
      // Force reconnection
      dbClient = null;
      client = await getDbClient();
      if (!client) {
        throw new Error('Failed to reconnect to database');
      }
    }

    _logger.info('[TRACE-DB-UPDATE] Database client obtained', {
      batch_id: batchId,
      client_valid: !!client,
      elapsed_ms: Date.now() - startTime,
    });

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

    _logger.info('[TRACE-DB-UPDATE] Executing UPDATE query', {
      batch_id: batchId,
      query: query.replace(/\s+/g, ' ').trim(),
      param_count: values.length,
      update_fields: updateFields.length,
      elapsed_ms: Date.now() - startTime,
    });

    const result = await client.query(query, values);
    
    const elapsed = Date.now() - startTime;
    const rowCount = result.rowCount || 0;
    
    _logger.info('[TRACE-DB-UPDATE] UPDATE query completed', {
      batch_id: batchId,
      row_count: rowCount,
      rows_affected: rowCount,
      has_result: !!result.rows[0],
      updated_status: result.rows[0]?.status,
      elapsed_ms: elapsed,
    });

    if (rowCount === 0) {
      _logger.error('[TRACE-DB-UPDATE-ERROR] UPDATE query affected 0 rows', {
        batch_id: batchId,
        query: query.replace(/\s+/g, ' ').trim(),
        values: values,
        elapsed_ms: elapsed,
      });
      throw new Error(`UPDATE query affected 0 rows for batch_id: ${batchId}`);
    }

    if (!result.rows[0]) {
      _logger.error('[TRACE-DB-UPDATE-ERROR] UPDATE query returned no rows', {
        batch_id: batchId,
        row_count: rowCount,
        elapsed_ms: elapsed,
      });
      throw new Error(`UPDATE query returned no rows for batch_id: ${batchId}`);
    }

    _logger.info('[TRACE-DB-UPDATE] Status update successful', {
      batch_id: batchId,
      old_status: 'pending', // We don't track this, but log for reference
      new_status: result.rows[0].status,
      elapsed_ms: elapsed,
    });

    return result.rows[0];
  } catch (error) {
    const elapsed = Date.now() - startTime;
    _logger.error('[TRACE-DB-UPDATE-ERROR] Failed to update batch job status', {
      batch_id: batchId,
      error: error.message,
      error_code: error.code,
      error_stack: error.stack,
      updates: updates,
      elapsed_ms: elapsed,
    });
    // Reset connection on error (might be connection issue)
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' || error.message.includes('connection')) {
      _logger.warn('[TRACE-DB-UPDATE-ERROR] Connection error detected, resetting connection', {
        batch_id: batchId,
        error_code: error.code,
      });
      dbClient = null;
    }
    throw error;
  }
}

/**
 * Get batch job by batch_id
 */
async function getBatchJob(batchId) {
  try {
    const client = await getDbClient();
    const query = 'SELECT * FROM prepper.batch_jobs WHERE batch_id = $1';
    const result = await client.query(query, [batchId]);
    return result.rows[0];
  } catch (error) {
    _logger.error('[TRACE-DB-GET-ERROR] Failed to retrieve batch job', {
      batch_id: batchId,
      error: error.message,
      error_code: error.code,
      stack: error.stack,
    });
    // Reset connection on error
    dbClient = null;
    throw error;
  }
}

/**
 * Get all pending/active batches for polling
 */
async function getPendingBatches() {
  try {
    const client = await getDbClient();
    const query = `
      SELECT * FROM prepper.batch_jobs
      WHERE status IN ('pending', 'validating', 'in_progress')
      ORDER BY created_at ASC
    `;
    const result = await client.query(query);
    
    _logger.info('[TRACE-DB-GET] Retrieved pending batches', {
      batch_count: result.rows.length,
      max_pending_age_hours: MAX_PENDING_AGE_HOURS,
    });
    
    return result.rows;
  } catch (error) {
    _logger.error('[TRACE-DB-GET-ERROR] Failed to retrieve pending batches', {
      error: error.message,
      error_code: error.code,
      stack: error.stack,
    });
    // Reset connection on error
    dbClient = null;
    throw error;
  }
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
 *               output_format:
 *                 type: string
 *                 enum: [json, sql]
 *                 default: json
 *                 description: Output format - 'json' returns JSON response, 'sql' returns SQL INSERT statements
 *               multiple_answers:
 *                 type: boolean
 *                 default: false
 *                 description: If true, generates questions with multiple correct answers (2-3 correct options)
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
 *           text/plain:
 *             schema:
 *               type: string
 *             description: SQL INSERT statements (when output_format is 'sql')
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
      output_format = 'json',
      multiple_answers = '0', // 0 for false, 1 for true
      model = CLAUDE_HAIKU_4_5
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

    // Validate output_format
    if (!['json', 'sql'].includes(output_format)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid output_format. Must be "json" or "sql"',
      });
    }

    _logger.info(`Generating ${count} questions for ${certification_type}`, {
      user: req.user?.username,
      domain: domain_name,
      cognitive_level,
      skill_level,
      output_format,
      multiple_answers
    });

    // Build the prompt
    const prompt = buildGenerationPrompt({
      certification_type,
      domain_name,
      cognitive_level,
      skill_level,
      scenario_context,
      count,
      multiple_answers
    });

    _logger.info('Prompt', {
      "Prompt generated": prompt,
    });

    // Call Claude API
    const message = await anthropic.messages.create({
      model,
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
    _logger.info('Claude response text', {
      "Message": message,
    });

    // Parse the JSON response
    let questions;
    try {
      // Try to extract JSON from markdown code blocks if present
      const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
      const jsonText = jsonMatch ? jsonMatch[1] : responseText;
      _logger.info('JSON text', {
        json_text: jsonText,
      });
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
    _logger.info('Questions', {
      questions: questions,
      output_format,
    });

    // Return SQL or JSON based on output_format
    if (output_format === 'sql') {
      const sqlContent = questionsToSql(questions, certification_type);
      
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="questions_${Date.now()}.sql"`);
      return res.send(sqlContent);
    } else {
      // Default JSON response
      res.json({
        success: true,
        count: questions.length,
        questions: questions,
        metadata: {
          certification_type,
          domain_name,
          cognitive_level,
          skill_level,
          multiple_answers: isMultipleAnswers,
          generated_at: new Date().toISOString(),
          generated_by: req.user?.username,
        },
      });
    }
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

router.post('/generateBatch', authenticateToken, async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const startTime = Date.now();

  _logger.info('[TRACE-START] /generateBatch endpoint called', {
    request_id: requestId,
    user: req.user?.username,
    user_id: req.user?.id,
    timestamp: new Date().toISOString(),
  });

  try {
    const {
      certification_type,
      domain_name,
      cognitive_level,
      skill_level,
      count,
      scenario_context,
      output_format = 'json',
      multiple_answers = '0', // 0 for false, 1 for true
      model = CLAUDE_OPUS_4_5
    } = req.body;

    _logger.info('[TRACE] Request body parsed', {
      request_id: requestId,
      certification_type,
      domain_name,
      'multiple_answers': multiple_answers,
      'model': model,
      'output_format': output_format,
      'scenario_context': scenario_context,
      'cognitive_level': cognitive_level,
      'skill_level': skill_level,
      count,
      elapsed_ms: Date.now() - startTime,
    });

    // Validate required fields
    if (!certification_type) {
      _logger.warn('[TRACE] Validation failed: missing certification_type', { request_id: requestId });
      return res.status(400).json({
        success: false,
        error: 'certification_type is required',
      });
    }

    if (!count) {
      _logger.warn('[TRACE] Validation failed: missing count', { request_id: requestId });
      return res.status(400).json({
        success: false,
        error: 'count is required',
      });
    }

    // Validate certification type
    if (!['CV0-004', 'SAA-C03'].includes(certification_type)) {
      _logger.warn('[TRACE] Validation failed: invalid certification_type', {
        request_id: requestId,
        certification_type
      });
      return res.status(400).json({
        success: false,
        error: 'Invalid certification_type. Must be CV0-004 or SAA-C03',
      });
    }

    // Validate count (allow any positive number for testing)
    if (count < 1) {
      _logger.warn('[TRACE] Validation failed: invalid count', { request_id: requestId, count });
      return res.status(400).json({
        success: false,
        error: 'count must be at least 1',
      });
    }

    // Validate batch endpoint is configured
    if (!_batchurl) {
      _logger.error('[TRACE] Batch endpoint not configured', {
        request_id: requestId,
        user: req.user?.username,
      });
      return res.status(500).json({
        success: false,
        error: 'Batch endpoint not configured',
      });
    }

    _logger.info('[TRACE] All validations passed', {
      request_id: requestId,
      elapsed_ms: Date.now() - startTime,
    });

    // Generate local batch ID
    const localBatchId = generateBatchId();

    _logger.info('[TRACE] Local batch ID generated', {
      request_id: requestId,
      batch_id: localBatchId,
      elapsed_ms: Date.now() - startTime,
    });

    _logger.info(`Submitting batch request for ${count} questions`, {
      request_id: requestId,
      user: req.user?.username,
      batch_id: localBatchId,
      certification_type,
      domain: domain_name,
      cognitive_level,
      skill_level,
      count,
    });

    // Create batch request with individual message requests
    _logger.info('[TRACE] Building batch requests', {
      request_id: requestId,
      batch_id: localBatchId,
      count,
      elapsed_ms: Date.now() - startTime,
    });

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
          model: CLAUDE_OPUS_4_5,
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

    _logger.info('[TRACE] Batch requests built, calling submitBatchRequest', {
      request_id: requestId,
      batch_id: localBatchId,
      request_count: batchRequests.length,
      elapsed_ms: Date.now() - startTime,
    });

    // Submit batch to Anthropic API
    const anthropicBatchId = await submitBatchRequest(batchRequests, requestId, localBatchId);

    _logger.info('[TRACE] Batch submitted to Anthropic API successfully', {
      request_id: requestId,
      batch_id: localBatchId,
      anthropic_batch_id: anthropicBatchId,
      request_count: count ?? 0,
      elapsed_ms: Date.now() - startTime,
    });

    _logger.info('[TRACE] Storing batch job in database', {
      request_id: requestId,
      batch_id: localBatchId,
      anthropic_batch_id: anthropicBatchId,
      elapsed_ms: Date.now() - startTime,
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

    _logger.info('[TRACE] Batch job stored in database successfully', {
      request_id: requestId,
      batch_id: localBatchId,
      db_id: batchJob.id,
      elapsed_ms: Date.now() - startTime,
    });

    _logger.info('[TRACE] Sending response to client', {
      request_id: requestId,
      batch_id: localBatchId,
      elapsed_ms: Date.now() - startTime,
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

    _logger.info('[TRACE-END] Response sent successfully', {
      request_id: requestId,
      total_elapsed_ms: Date.now() - startTime,
    });
  } catch (error) {
    _logger.error('[TRACE-ERROR] Batch submission failed', {
      request_id: requestId,
      error: error.message,
      stack: error.stack,
      user: req.user?.username,
      elapsed_ms: Date.now() - startTime,
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
// Helper function to handle batch status retrieval (shared by all compatibility endpoints)
async function handleBatchStatusRequest(req, res, batchId) {
  try {
    const batchJob = await getBatchJob(batchId);
    if (!batchJob) {
      return res.status(404).json({
        success: false,
        error: 'Batch not found',
        batch_id: batchId,
      });
    }

    // Check if batch is expired (either marked as expired or too old)
    // Ensure status is always a valid string (default to 'pending' if null/undefined)
    let finalStatus = batchJob.status || 'pending';
    let errorMessage = batchJob.error_message || null;
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:1496',message:'Batch status retrieval',data:{batch_id:batchId,db_status:batchJob.status,final_status:finalStatus,status_type:typeof batchJob.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    // Check if batch is too old and should be considered expired
    if (batchJob.status !== 'expired' && batchJob.status !== 'completed' && batchJob.status !== 'error') {
      const batchCreatedAt = batchJob.created_at ? new Date(batchJob.created_at) : null;
      if (batchCreatedAt) {
        const batchAgeMs = Date.now() - batchCreatedAt.getTime();
        const batchAgeHours = batchAgeMs / (1000 * 60 * 60);
        
        if (batchAgeMs > MAX_PENDING_AGE_MS) {
          finalStatus = 'expired';
          errorMessage = `Batch exceeded maximum pending age of ${MAX_PENDING_AGE_HOURS} hours. Age: ${batchAgeHours.toFixed(2)} hours.`;
          
          _logger.warn('[TRACE-STATUS] Batch is expired due to age', {
            batch_id: batchId,
            current_status: batchJob.status,
            age_hours: batchAgeHours.toFixed(2),
            max_age_hours: MAX_PENDING_AGE_HOURS,
          });
        }
      }
    }

    // If batch is expired, return early with expired status
    if (finalStatus === 'expired') {
      return res.json({
        success: true,
        batch_id: batchJob.batch_id,
        anthropic_batch_id: batchJob.anthropic_batch_id,
        status: 'expired',
        progress: {
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
        error_message: errorMessage,
      });
    }

    // Parse JSON fields (handle both string and object from JSONB)
    let requestParams = null;
    try {
      requestParams = batchJob.request_params
        ? (typeof batchJob.request_params === 'string' 
            ? JSON.parse(batchJob.request_params) 
            : batchJob.request_params)
        : null;
    } catch (parseError) {
      _logger.warn('Error parsing request_params, continuing without it', {
        batch_id: batchId,
        error: parseError.message,
      });
      // Continue without request_params if parsing fails
    }

    res.json({
      success: true,
      batch_id: batchJob.batch_id,
      anthropic_batch_id: batchJob.anthropic_batch_id,
      status: finalStatus,
      progress: {
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
      error_message: errorMessage,
    });
  } catch (error) {
    _logger.error('Error retrieving batch status', {
      error: error.message,
      stack: error.stack,
      batch_id: batchId,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve batch status',
      details: error.message,
    });
  }
}

// Handle alternative batchStatus endpoint (client compatibility)
router.get('/batchStatus/:batchId', authenticateToken, async (req, res) => {
  return handleBatchStatusRequest(req, res, req.params.batchId);
});

// Handle batchResults endpoint (client compatibility)
router.get('/batchResults/:batchId', authenticateToken, async (req, res) => {
  // For batchResults, redirect to results endpoint logic
  const { batchId } = req.params;
  try {
    const batchJob = await getBatchJob(batchId);
    if (!batchJob) {
      return res.status(404).json({
        success: false,
        error: 'Batch not found',
        batch_id: batchId,
      });
    }

    // Ensure status is always a valid string
    const batchStatus = batchJob.status || 'unknown';
    
    // Handle different batch statuses
    if (batchStatus === 'error') {
      // For error status, return error details but still allow checking for partial results
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

      // Return 200 with success: false to indicate the request succeeded but batch failed
      return res.status(200).json({
        success: false,
        error: 'Batch processing failed',
        batch_id: batchJob.batch_id,
        status: batchStatus,
        error_message: batchJob.error_message || 'Unknown error occurred',
        partial_results: questions.length > 0,
        questions: questions.length > 0 ? questions : undefined,
        message: 'Batch processing failed. Partial results may be available if any were generated before the error.',
        note: 'Use the status endpoint to check batch status. Results are only available for completed batches.',
      });
    }

    if (batchStatus === 'expired' || batchStatus === 'cancelled') {
      // Return 200 with success: false to indicate the request succeeded but batch is not available
      return res.status(200).json({
        success: false,
        error: `Batch ${batchStatus}`,
        batch_id: batchJob.batch_id,
        status: batchStatus,
        error_message: batchJob.error_message || `Batch was ${batchStatus}`,
        message: 'This batch cannot provide results as it was not completed successfully.',
        note: 'Use the status endpoint to check batch status. Results are only available for completed batches.',
      });
    }

    if (batchStatus !== 'completed') {
      // Return 200 with success: false for in-progress batches
      return res.status(200).json({
        success: false,
        error: 'Batch is not completed',
        batch_id: batchId,
        status: batchStatus,
        message: `Batch is still in progress (status: ${batchStatus}). Use the status endpoint to check batch progress.`,
        note: 'Results are only available for completed batches. Please wait for the batch to complete or check the status endpoint for updates.',
      });
    }
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
      status: 'completed',
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

// Handle /batch/:batchId (without /status) - return status
router.get('/batch/:batchId', authenticateToken, async (req, res) => {
  return handleBatchStatusRequest(req, res, req.params.batchId);
});

// Handle batch status requests (support both path param and query param for compatibility)
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

    // Check if batch is expired (either marked as expired or too old)
    let finalStatus = batchJob.status;
    let errorMessage = batchJob.error_message || null;
    
    // Check if batch is too old and should be considered expired
    if (batchJob.status !== 'expired' && batchJob.status !== 'completed' && batchJob.status !== 'error') {
      const batchCreatedAt = batchJob.created_at ? new Date(batchJob.created_at) : null;
      if (batchCreatedAt) {
        const batchAgeMs = Date.now() - batchCreatedAt.getTime();
        const batchAgeHours = batchAgeMs / (1000 * 60 * 60);
        
        if (batchAgeMs > MAX_PENDING_AGE_MS) {
          finalStatus = 'expired';
          errorMessage = `Batch exceeded maximum pending age of ${MAX_PENDING_AGE_HOURS} hours. Age: ${batchAgeHours.toFixed(2)} hours.`;
          
          _logger.warn('[TRACE-STATUS] Batch is expired due to age', {
            batch_id: batchId,
            current_status: batchJob.status,
            age_hours: batchAgeHours.toFixed(2),
            max_age_hours: MAX_PENDING_AGE_HOURS,
          });
        }
      }
    }

    // If batch is expired, return early with expired status
    if (finalStatus === 'expired') {
      return res.json({
        success: true,
        batch_id: batchJob.batch_id,
        anthropic_batch_id: batchJob.anthropic_batch_id,
        status: 'expired',
        progress: {
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
        error_message: errorMessage,
      });
    }

    // Parse JSON fields (handle both string and object from JSONB)
    let requestParams = null;
    try {
      requestParams = batchJob.request_params
        ? (typeof batchJob.request_params === 'string' 
            ? JSON.parse(batchJob.request_params) 
            : batchJob.request_params)
        : null;
    } catch (parseError) {
      _logger.warn('Error parsing request_params, continuing without it', {
        batch_id: batchId,
        error: parseError.message,
      });
      // Continue without request_params if parsing fails
    }

    res.json({
      success: true,
      batch_id: batchJob.batch_id,
      anthropic_batch_id: batchJob.anthropic_batch_id,
      status: finalStatus,
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
      error_message: errorMessage,
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

    // Ensure status is always a valid string
    const batchStatus = batchJob.status || 'unknown';
    
    // Handle different batch statuses
    if (batchStatus === 'error') {
      // For error status, return error details but still allow checking for partial results
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

      // Return 200 with success: false to indicate the request succeeded but batch failed
      return res.status(200).json({
        success: false,
        error: 'Batch processing failed',
        batch_id: batchJob.batch_id,
        status: batchStatus,
        error_message: batchJob.error_message || 'Unknown error occurred',
        partial_results: questions.length > 0,
        questions: questions.length > 0 ? questions : undefined,
        message: 'Batch processing failed. Partial results may be available if any were generated before the error.',
        note: 'Use the status endpoint to check batch status. Results are only available for completed batches.',
      });
    }

    if (batchStatus === 'expired' || batchStatus === 'cancelled') {
      // Return 200 with success: false to indicate the request succeeded but batch is not available
      return res.status(200).json({
        success: false,
        error: `Batch ${batchStatus}`,
        batch_id: batchJob.batch_id,
        status: batchStatus,
        error_message: batchJob.error_message || `Batch was ${batchStatus}`,
        message: 'This batch cannot provide results as it was not completed successfully.',
        note: 'Use the status endpoint to check batch status. Results are only available for completed batches.',
      });
    }

    if (batchStatus !== 'completed') {
      // Return 200 with success: false for in-progress batches
      return res.status(200).json({
        success: false,
        error: 'Batch is not completed',
        batch_id: batchId,
        status: batchStatus,
        message: `Batch is still in progress (status: ${batchStatus}). Use the status endpoint to check batch progress.`,
        note: 'Results are only available for completed batches. Please wait for the batch to complete or check the status endpoint for updates.',
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
      status: 'completed',
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
async function submitBatchRequest(requests, requestId, batchId) {
  const url = _batchurl;
  const startTime = Date.now();

  _logger.info('[TRACE-API] Preparing to submit batch request to Anthropic API', {
    request_id: requestId,
    batch_id: batchId,
    url,
    request_count: requests.length,
    has_api_key: !!process.env.ANTHROPIC_API_KEY,
  });

  try {
    _logger.info('[TRACE-API] Sending POST request to Anthropic', {
      request_id: requestId,
      batch_id: batchId,
      url,
      payload_size: JSON.stringify(requests).length,
    });

    const batch = await anthropic.messages.batches.create({
      requests: requests,
    });

    const elapsed = Date.now() - startTime;

    _logger.info('[TRACE-API] Received response from Anthropic API', {
      request_id: requestId,
      batch_id: batchId,
      batch_status: batch.status,
      batch_id_from_api: batch.id,
      elapsed_ms: elapsed,
    });

    if (!batch || !batch.id) {
      _logger.error('[TRACE-API] Invalid batch response: missing batch ID', {
        request_id: requestId,
        batch_id: batchId,
        batch_response: batch,
      });
      throw new Error('Invalid batch response: missing batch ID');
    }

    _logger.info('[TRACE-API] Batch submission successful', {
      request_id: requestId,
      batch_id: batchId,
      anthropic_batch_id: batch.id,
      batch_status: batch.status,
      elapsed_ms: elapsed,
    });

    return batch.id;
  } catch (error) {
    const elapsed = Date.now() - startTime;

    _logger.error('[TRACE-API-ERROR] Failed to submit batch request', {
      request_id: requestId,
      batch_id: batchId,
      error: error.message,
      error_code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      elapsed_ms: elapsed,
      is_timeout: error.code === 'ECONNABORTED',
    });
    throw new Error(`Batch submission failed: ${error.message}`);
  }
}

/**
 * Poll batch status from Anthropic API (used by background job)
 * Uses SDK's retrieve() method instead of axios
 */
async function pollBatchStatusFromAPI(anthropicBatchId) {
  const startTime = Date.now();
  _logger.info('Polling batch status from API', {
    anthropic_batch_id: anthropicBatchId,
    startTime,
  });

  try {
    const messageBatch = await anthropic.messages.batches.retrieve(anthropicBatchId);

    _logger.info('API response', {
      anthropic_batch_id: anthropicBatchId,
      processing_status: messageBatch.processing_status,
      batch_id: messageBatch.id,
      processed_count: messageBatch.processed_count,
      total_count: messageBatch.total_count,
      request_counts: messageBatch.request_counts,
    });

    return messageBatch;
  } catch (error) {
    _logger.error('Error polling batch status from API', {
      anthropic_batch_id: anthropicBatchId,
      error: error.message,
      error_code: error.code,
      error_status: error.status,
    });
    throw error;
  }
}

/**
 * Retrieve and parse batch results from Anthropic API
 */
async function retrieveBatchResultsFromAPI(anthropicBatchId) {
  const url = `${_batchurl}/${anthropicBatchId}/results`;
  const allQuestions = [];

  _logger.info('Retrieving batch results from API', {
    anthropic_batch_id: anthropicBatchId,
    url: url,
  });

  try {
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2120',message:'Starting batch results retrieval',data:{url:url,anthropic_batch_id:anthropicBatchId},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    const response = await axios.get(url, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      responseType: 'text', // Force text response to prevent auto-parsing - Anthropic returns NDJSON
    });

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2135',message:'Received API response',data:{data_type:typeof response.data,is_string:typeof response.data === 'string',data_length:typeof response.data === 'string' ? response.data.length : 'N/A',has_newlines:typeof response.data === 'string' ? response.data.includes('\n') : false,newline_count:typeof response.data === 'string' ? (response.data.match(/\n/g) || []).length : 0,data_preview:typeof response.data === 'string' ? response.data.substring(0,200) : String(response.data).substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    // Parse response - Anthropic batch results API returns NDJSON (newline-delimited JSON)
    // Each line is a separate JSON object: {"custom_id":"...","result":{...}}\n{"custom_id":"...","result":{...}}
    let parsedData = [];
    
    if (typeof response.data === 'string') {
      // NDJSON format - parse each line
      const lines = response.data.trim().split('\n').filter(line => line.trim());
      _logger.info('Parsing NDJSON response', {
        anthropic_batch_id: anthropicBatchId,
        total_lines: lines.length,
        first_line_preview: lines[0]?.substring(0, 100),
      });
      
      parsedData = lines.map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (parseError) {
          _logger.error('Failed to parse NDJSON line', {
            anthropic_batch_id: anthropicBatchId,
            line_index: index,
            error: parseError.message,
            line_preview: line.substring(0, 100),
          });
          return null;
        }
      }).filter(item => item !== null);
      
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2155',message:'Parsed NDJSON response',data:{lines_count:lines.length,parsed_count:parsedData.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
    } else {
      // Fallback: if axios parsed it somehow, try to use it directly
      _logger.warn('Response data is not a string, unexpected format', {
        anthropic_batch_id: anthropicBatchId,
        data_type: typeof response.data,
        is_array: Array.isArray(response.data),
      });
      parsedData = Array.isArray(response.data) ? response.data : [response.data];
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2165',message:'Response already parsed (unexpected)',data:{is_array:Array.isArray(parsedData),data_type:typeof response.data,parsed_count:parsedData.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
    }

    // parsedData should now be an array of result objects from NDJSON parsing
    // Each object has structure: {custom_id: "...", result: {type: "succeeded", message: {...}}}
    const results = Array.isArray(parsedData) ? parsedData : [];
    
    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2172',message:'Results array prepared',data:{results_length:results.length,first_result_keys:results[0] ? Object.keys(results[0]) : null},timestamp:Date.now(),sessionId:'debug-session',runId:'run2',hypothesisId:'B'})}).catch(()=>{});
    // #endregion

    _logger.info('Processing batch results', {
      anthropic_batch_id: anthropicBatchId,
      result_count: results.length,
      response_keys: Array.isArray(parsedData) ? 'array' : (parsedData ? Object.keys(parsedData) : 'null'),
    });

    if (results.length === 0) {
      _logger.warn('No results found in batch response', {
        anthropic_batch_id: anthropicBatchId,
        response_data_type: typeof parsedData,
        response_data_keys: Array.isArray(parsedData) ? 'array' : (parsedData ? Object.keys(parsedData) : 'null'),
        response_data_preview: typeof parsedData === 'string' ? parsedData.substring(0, 1000) : JSON.stringify(parsedData).substring(0, 1000),
      });
    }

    for (const result of results) {
      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2176',message:'Processing result item',data:{result_keys:Object.keys(result || {}),has_error:!!result.error,has_response:!!result.response,has_result:!!result.result,result_type:result.result?.type,has_message:!!result.result?.message,response_path_text:result.response?.content?.[0]?.text ? 'found' : 'missing',message_path_text:result.result?.message?.content?.[0]?.text ? 'found' : 'missing'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion

      // Check for errors in result
      if (result.error) {
        _logger.warn('Batch result contains error', {
          anthropic_batch_id: anthropicBatchId,
          custom_id: result.custom_id,
          error: result.error,
        });
        continue;
      }

      // Check if result type is not succeeded
      if (result.result && result.result.type !== 'succeeded') {
        _logger.warn('Batch result type is not succeeded', {
          anthropic_batch_id: anthropicBatchId,
          custom_id: result.custom_id,
          result_type: result.result.type,
        });
        continue;
      }

      try {
        // Extract response text from result - try multiple paths
        // Anthropic batch results API structure: {custom_id: "...", result: {type: "succeeded", message: {content: [{type: "text", text: "..."}]}}}
        let responseText = null;
        
        // Try path: result.result.message.content[0].text (actual API structure)
        if (result.result?.message?.content?.[0]?.text) {
          responseText = result.result.message.content[0].text;
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2191',message:'Using result.message.content path',data:{text_found:!!responseText,text_length:responseText?.length || 0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
        } else if (result.response?.content?.[0]?.text) {
          // Fallback: try result.response.content[0].text (alternative structure)
          responseText = result.response.content[0].text;
          // #region agent log
          fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2196',message:'Using result.response.content path',data:{text_found:!!responseText,text_length:responseText?.length || 0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7243/ingest/c279037b-eef4-473c-a6bd-88e16fd94381',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'questions.js:2201',message:'Text extraction final result',data:{response_text_found:!!responseText,response_text_length:responseText?.length || 0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion

        if (!responseText) {
          _logger.warn('Batch result missing response text', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
            result_keys: Object.keys(result || {}),
            has_result: !!result.result,
            has_result_message: !!result.result?.message,
            has_result_content: !!result.result?.message?.content,
            has_response: !!result.response,
            has_response_content: !!result.response?.content,
          });
          continue;
        }

        _logger.info('Extracted response text from batch result', {
          anthropic_batch_id: anthropicBatchId,
          custom_id: result.custom_id,
          text_length: responseText.length,
          text_preview: responseText.substring(0, 200),
        });

        // Parse JSON from response
        let questions;
        try {
          const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
          const jsonText = jsonMatch ? jsonMatch[1] : responseText;
          questions = JSON.parse(jsonText);
          
          _logger.info('Parsed questions from batch result', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
            is_array: Array.isArray(questions),
            is_object: typeof questions === 'object',
            question_count: Array.isArray(questions) ? questions.length : (questions ? 1 : 0),
          });
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
          _logger.info('Adding array of questions', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
            count: questions.length,
          });
          allQuestions.push(...questions);
        } else if (questions && typeof questions === 'object') {
          _logger.info('Adding single question object', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
          });
          allQuestions.push(questions);
        } else {
          _logger.warn('Parsed questions is not in expected format', {
            anthropic_batch_id: anthropicBatchId,
            custom_id: result.custom_id,
            questions_type: typeof questions,
            questions_value: questions,
          });
        }
      } catch (error) {
        _logger.error('Error processing batch result', {
          anthropic_batch_id: anthropicBatchId,
          custom_id: result.custom_id,
          error: error.message,
          error_stack: error.stack,
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
  const pollStartTime = Date.now();
  // Declare variables outside try block so they're accessible in catch block
  let batchesProcessed = 0;
  let batchesUpdated = 0;
  let batchesFailed = 0;

  try {
    _logger.info('[TRACE-POLL] Starting pollPendingBatches', {
      timestamp: new Date().toISOString(),
    });

    const pendingBatches = await getPendingBatches();

    _logger.info('[TRACE-POLL] Retrieved pending batches', {
      batch_count: pendingBatches.length,
      batch_ids: pendingBatches.map(b => b.batch_id),
      elapsed_ms: Date.now() - pollStartTime,
    });

    if (pendingBatches.length === 0) {
      _logger.info('[TRACE-POLL] No pending batches to poll', {
        elapsed_ms: Date.now() - pollStartTime,
      });
      return; // No batches to poll
    }

    _logger.info(`[TRACE-POLL] Polling ${pendingBatches.length} pending batch(es)`, {
      batch_count: pendingBatches.length,
    });

    for (const batchJob of pendingBatches) {
      const batchStartTime = Date.now();
      batchesProcessed++;

      _logger.info('[TRACE-POLL] Processing batch', {
        batch_id: batchJob.batch_id,
        anthropic_batch_id: batchJob.anthropic_batch_id,
        current_status: batchJob.status,
        batch_number: batchesProcessed,
        total_batches: pendingBatches.length,
      });

      // Check if batch is too old and should be marked as error
      const batchCreatedAt = batchJob.created_at ? new Date(batchJob.created_at) : null;
      if (batchCreatedAt) {
        const batchAgeMs = Date.now() - batchCreatedAt.getTime();
        const batchAgeHours = batchAgeMs / (1000 * 60 * 60);
        
        _logger.info('[TRACE-POLL] Checking batch age', {
          batch_id: batchJob.batch_id,
          created_at: batchJob.created_at,
          age_ms: batchAgeMs,
          age_hours: batchAgeHours.toFixed(2),
          max_age_hours: MAX_PENDING_AGE_HOURS,
        });

        if (batchAgeMs > MAX_PENDING_AGE_MS) {
          _logger.warn('[TRACE-POLL-TIMEOUT] Batch exceeds maximum pending age, marking as error', {
            batch_id: batchJob.batch_id,
            anthropic_batch_id: batchJob.anthropic_batch_id,
            created_at: batchJob.created_at,
            age_hours: batchAgeHours.toFixed(2),
            max_age_hours: MAX_PENDING_AGE_HOURS,
          });

          try {
            await updateBatchJobStatus(batchJob.batch_id, {
              status: 'error',
              error_message: `Batch exceeded maximum pending age of ${MAX_PENDING_AGE_HOURS} hours. Age: ${batchAgeHours.toFixed(2)} hours.`,
              completed_at: new Date().toISOString(),
            });
            
            _logger.info('[TRACE-POLL-TIMEOUT] Old batch marked as error', {
              batch_id: batchJob.batch_id,
            });
            
            batchesUpdated++;
            continue; // Skip to next batch
          } catch (timeoutError) {
            _logger.error('[TRACE-POLL-TIMEOUT-ERROR] Failed to mark old batch as error', {
              batch_id: batchJob.batch_id,
              error: timeoutError.message,
            });
            batchesFailed++;
            continue; // Skip to next batch
          }
        }
      }

      try {
        // Poll Anthropic API for status
        _logger.info('[TRACE-POLL] Polling Anthropic API for batch status', {
          batch_id: batchJob.batch_id,
          anthropic_batch_id: batchJob.anthropic_batch_id,
        });

        const messageBatch = await pollBatchStatusFromAPI(
          batchJob.anthropic_batch_id
        );

        // Use processing_status directly from SDK response
        const processingStatus = messageBatch.processing_status;
        
        _logger.info('[TRACE-POLL] Received batch status from Anthropic API', {
          batch_id: batchJob.batch_id,
          anthropic_batch_id: batchJob.anthropic_batch_id,
          processing_status: processingStatus,
          processed_count: messageBatch.processed_count,
          total_count: messageBatch.total_count,
          request_counts: messageBatch.request_counts,
        });

        // Map Anthropic API processing_status values to our internal status values
        // SDK uses 'ended' for completed batches
        let status;
        if (processingStatus === 'ended') {
          status = 'completed';
        } else if (processingStatus === 'in_progress' || processingStatus === 'validating' || processingStatus === 'pending') {
          status = processingStatus;
        } else if (processingStatus === 'expired' || processingStatus === 'cancelled' || processingStatus === 'canceled') {
          status = processingStatus === 'canceled' ? 'cancelled' : processingStatus;
        } else {
          _logger.warn('[TRACE-POLL-WARN] Unexpected processing_status value from API', {
            batch_id: batchJob.batch_id,
            anthropic_batch_id: batchJob.anthropic_batch_id,
            received_status: processingStatus,
          });
          status = processingStatus || 'pending'; // Default to pending if unknown
        }
        
        if (!status) {
          _logger.error('[TRACE-POLL-ERROR] Empty status received from API', {
            batch_id: batchJob.batch_id,
            anthropic_batch_id: batchJob.anthropic_batch_id,
            processing_status: processingStatus,
          });
          throw new Error('Empty status received from Anthropic API');
        }

        const updates = {
          status: status,
        };

        _logger.info('[TRACE-POLL] Batch status update prepared', {
          batch_id: batchJob.batch_id,
          anthropic_batch_id: batchJob.anthropic_batch_id,
          status,
          processing_status: processingStatus,
          processed_count: messageBatch.processed_count,
          total_count: messageBatch.total_count,
        });

        // If batch is completed, retrieve and store results
        if (status === 'completed') {
          _logger.info('[TRACE-POLL] Batch is completed, retrieving results', {
            batch_id: batchJob.batch_id,
            anthropic_batch_id: batchJob.anthropic_batch_id,
          });

          try {
            let allQuestions = await retrieveBatchResultsFromAPI(
              batchJob.anthropic_batch_id
            );

            // If API retrieval returned empty, try to get from database (might have been saved earlier)
            if (allQuestions.length === 0 && batchJob.results) {
              _logger.warn('[TRACE-POLL] API returned 0 questions, trying to retrieve from database', {
                batch_id: batchJob.batch_id,
                has_db_results: !!batchJob.results,
              });
              try {
                const dbResults = typeof batchJob.results === 'string' 
                  ? JSON.parse(batchJob.results) 
                  : batchJob.results;
                allQuestions = Array.isArray(dbResults) ? dbResults : (dbResults ? [dbResults] : []);
                _logger.info('[TRACE-POLL] Retrieved questions from database', {
                  batch_id: batchJob.batch_id,
                  question_count: allQuestions.length,
                });
              } catch (dbParseError) {
                _logger.error('[TRACE-POLL] Failed to parse database results', {
                  batch_id: batchJob.batch_id,
                  error: dbParseError.message,
                });
              }
            }

            updates.results = allQuestions;
            updates.completed_at = new Date().toISOString();

            _logger.info('[TRACE-POLL] Batch completed, results retrieved', {
              batch_id: batchJob.batch_id,
              question_count: allQuestions.length,
              source: allQuestions.length > 0 ? (batchJob.results ? 'database_fallback' : 'api') : 'none',
            });

            // Always save results to file (even if empty, so we can see what was returned)
            // Save results to file for MCP server access
            const batchMetadata = {
              certification_type: batchJob.certification_type,
              domain_name: batchJob.domain_name,
              cognitive_level: batchJob.cognitive_level,
              skill_level: batchJob.skill_level,
              count: batchJob.count,
              anthropic_batch_id: batchJob.anthropic_batch_id,
              created_at: batchJob.created_at,
              completed_at: updates.completed_at,
              username: batchJob.username,
            };
            
            const savedFilePath = await saveBatchResultsToFile(
              batchJob.batch_id,
              allQuestions,
              batchMetadata
            );
            
            if (savedFilePath) {
              if (allQuestions.length > 0) {
                _logger.info('[TRACE-POLL] Batch results saved to file successfully', {
                  batch_id: batchJob.batch_id,
                  file_path: savedFilePath,
                  question_count: allQuestions.length,
                });
              } else {
                _logger.warn('[TRACE-POLL] Batch completed but no questions retrieved, file created with 0 questions', {
                  batch_id: batchJob.batch_id,
                  anthropic_batch_id: batchJob.anthropic_batch_id,
                  file_path: savedFilePath,
                });
              }
            }
          } catch (resultError) {
            _logger.error('[TRACE-POLL-ERROR] Failed to retrieve batch results', {
              batch_id: batchJob.batch_id,
              anthropic_batch_id: batchJob.anthropic_batch_id,
              error: resultError.message,
              error_stack: resultError.stack,
            });
            updates.error_message = `Failed to retrieve results: ${resultError.message}`;
          }
        } else if (['expired', 'cancelled'].includes(status)) {
          updates.error_message =
            batchStatus.error?.message || `Batch ${status}`;
          updates.completed_at = new Date().toISOString();
          
          _logger.info('[TRACE-POLL] Batch is expired/cancelled', {
            batch_id: batchJob.batch_id,
            status,
            error_message: updates.error_message,
          });
        }

        // Update database
        _logger.info('[TRACE-POLL] Calling updateBatchJobStatus', {
          batch_id: batchJob.batch_id,
          updates: {
            status: updates.status,
            has_results: updates.results !== undefined,
            has_error_message: !!updates.error_message,
            completed_at: updates.completed_at,
          },
        });

        const updateResult = await updateBatchJobStatus(batchJob.batch_id, updates);
        
        if (!updateResult) {
          _logger.error('[TRACE-POLL-ERROR] updateBatchJobStatus returned null/undefined', {
            batch_id: batchJob.batch_id,
            anthropic_batch_id: batchJob.anthropic_batch_id,
          });
          batchesFailed++;
        } else {
          batchesUpdated++;
          _logger.info('[TRACE-POLL] Batch status updated successfully', {
            batch_id: batchJob.batch_id,
            new_status: updateResult.status,
            elapsed_ms: Date.now() - batchStartTime,
          });
        }
      } catch (error) {
        batchesFailed++;
        _logger.error('[TRACE-POLL-ERROR] Error polling batch', {
          batch_id: batchJob.batch_id,
          anthropic_batch_id: batchJob.anthropic_batch_id,
          error: error.message,
          error_code: error.code,
          error_stack: error.stack,
          elapsed_ms: Date.now() - batchStartTime,
        });

        // Update with error status
        try {
          _logger.info('[TRACE-POLL] Updating batch to error status', {
            batch_id: batchJob.batch_id,
            error_message: error.message,
          });
          
          await updateBatchJobStatus(batchJob.batch_id, {
            status: 'error',
            error_message: error.message,
          });
          
          _logger.info('[TRACE-POLL] Batch marked as error', {
            batch_id: batchJob.batch_id,
          });
        } catch (updateError) {
          _logger.error('[TRACE-POLL-ERROR] Failed to update batch to error status', {
            batch_id: batchJob.batch_id,
            update_error: updateError.message,
            original_error: error.message,
          });
        }
      }
    }

    _logger.info('[TRACE-POLL] Completed pollPendingBatches', {
      batches_processed: batchesProcessed,
      batches_updated: batchesUpdated,
      batches_failed: batchesFailed,
      total_elapsed_ms: Date.now() - pollStartTime,
    });
  } catch (error) {
    _logger.error('[TRACE-POLL-ERROR] Error in background polling job', {
      error: error.message,
      error_code: error.code,
      stack: error.stack,
      batches_processed,
      batches_updated,
      batches_failed,
      total_elapsed_ms: Date.now() - pollStartTime,
    });
  }
}

/**
 * Start background polling interval
 */
function startBackgroundPolling() {
  _logger.info('[TRACE-POLL-START] Starting background batch polling', {
    interval_ms: BACKGROUND_POLL_INTERVAL,
    interval_minutes: BACKGROUND_POLL_INTERVAL / 60000,
    timestamp: new Date().toISOString(),
  });

  let pollCount = 0;
  let lastPollTime = Date.now();

  // Poll immediately on startup
  _logger.info('[TRACE-POLL-START] Executing initial poll on startup', {
    timestamp: new Date().toISOString(),
  });

  pollPendingBatches()
    .then(() => {
      pollCount++;
      lastPollTime = Date.now();
      _logger.info('[TRACE-POLL-START] Initial poll completed successfully', {
        poll_count: pollCount,
        timestamp: new Date().toISOString(),
      });
    })
    .catch((error) => {
      _logger.error('[TRACE-POLL-START-ERROR] Error in initial background poll', {
        error: error.message,
        error_stack: error.stack,
        timestamp: new Date().toISOString(),
      });
    });

  // Then poll at intervals
  const intervalId = setInterval(() => {
    pollCount++;
    const timeSinceLastPoll = Date.now() - lastPollTime;
    
    _logger.info('[TRACE-POLL-HEARTBEAT] Background polling heartbeat', {
      poll_count: pollCount,
      time_since_last_poll_ms: timeSinceLastPoll,
      expected_interval_ms: BACKGROUND_POLL_INTERVAL,
      timestamp: new Date().toISOString(),
    });

    lastPollTime = Date.now();
    
    pollPendingBatches()
      .then(() => {
        _logger.info('[TRACE-POLL-HEARTBEAT] Poll completed successfully', {
          poll_count: pollCount,
          timestamp: new Date().toISOString(),
        });
      })
      .catch((error) => {
        _logger.error('[TRACE-POLL-HEARTBEAT-ERROR] Error in background polling interval', {
          poll_count: pollCount,
          error: error.message,
          error_stack: error.stack,
          timestamp: new Date().toISOString(),
        });
      });
  }, BACKGROUND_POLL_INTERVAL);

  _logger.info('[TRACE-POLL-START] Background polling interval started', {
    interval_id: intervalId ? 'set' : 'not_set',
    interval_ms: BACKGROUND_POLL_INTERVAL,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Build the generation prompt for Claude
 */
/**
 * Build the generation prompt for Claude
 * This version uses the CORRECT schema matching your database
 */
function buildGenerationPrompt(params) {
  const {
    certification_type,
    domain_name,
    cognitive_level,
    skill_level,
    scenario_context,
    count,
    multiple_answers = '0',
  } = params;

  const currentYear = new Date().getFullYear();

  // Domain weight mapping
  const weight = DOMAIN_WEIGHTS[domain_name];

  let prompt = `You are an expert certification exam question writer for ${certification_type}.

CRITICAL SCHEMA REQUIREMENTS - YOU MUST FOLLOW THIS EXACTLY:

1. OPTIONS FORMAT (REQUIRED):
   Options MUST be an array of objects with "text" and "isCorrect" properties:
   "options": [
     {"text": "First option text", "isCorrect": false},
     {"text": "Second option text", "isCorrect": true},
     {"text": "Third option text", "isCorrect": false},
     {"text": "Fourth option text", "isCorrect": false}
   ]
   ${multiple_answers === '1' ? 'NOTE: For multiple-answer questions, mark 2-3 options as "isCorrect": true' : ''}

2. CORRECT ANSWER FORMAT (REQUIRED):
   ${multiple_answers === '1' 
     ? '- Multiple answers: "correct_answer": null, "correct_answers": ["Full text of option 1", "Full text of option 2"], "multiple_answers": "1"\n   - Mark 2-3 options with "isCorrect": true'
     : '- Single answer: "correct_answer": "Full text of correct option", "correct_answers": null, "multiple_answers": null\n   - Mark exactly ONE option with "isCorrect": true'}

3. EXPLANATION_DETAILS FORMAT (REQUIRED):
   Must be a structured object with these exact keys:
   "explanation_details": {
     "summary": "One-line summary introducing the concept:",
     "breakdown": [
       "First key point explaining why this is correct",
       "Second key point with technical details",
       "Third point about implementation"
     ],
     "otherOptions": "Option A is wrong because...\\nOption C is wrong because...\\nOption D is wrong because..."
   }

CONTENT REQUIREMENTS:
1. NEVER copy or paraphrase existing exam questions
2. Create original scenarios based on real-world ${currentYear} cloud architectures
3. Questions must test practical application, not memorization
4. Use current cloud services and best practices
5. Provide detailed explanations with technical reasoning
6. Include relevant references in the "references" field as an array of strings

REFERENCES REQUIREMENTS:
- Include 2-4 official documentation references per question
- For CV0-004: Include CompTIA Cloud+ official study materials, AWS/Azure/GCP documentation, or industry best practice guides
- For SAA-C03: Include AWS Well-Architected Framework, AWS service documentation, or AWS whitepapers
- Format as array: ["Reference 1", "Reference 2", "Reference 3"]
- Examples: ["AWS Well-Architected Framework - Reliability Pillar", "AWS EC2 User Guide - Auto Scaling", "CompTIA Cloud+ Study Guide Chapter 5"]
- If no specific references apply, use: ["Official ${certification_type} Exam Objectives", "Industry Best Practices"]

`;

  if (domain_name) {
    prompt += `DOMAIN FOCUS: ${domain_name} (Weight: ${weight}%)\n`;
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
1. Start with a realistic business scenario (healthcare, finance, manufacturing, etc.)
2. Include specific technical constraints (budgets, timelines, requirements)
3. Present 4-5 plausible options (all within same technical domain)
${multiple_answers === '1' ? '4. Mark 2-3 correct answers with "isCorrect": true (multiple-answer question)' : '4. Mark exactly ONE correct answer with "isCorrect": true (single-answer question)'}
5. Provide comprehensive explanation with implementation details

AVOID:
- Generic placeholder distractors like "Outdated legacy method"
- Obviously wrong answers
- Options from completely different domains
- Surface-level explanations

Generate ${count} question(s) and return ONLY a JSON array with this EXACT structure:

${multiple_answers === '1' ? `[
  {
    "question_text": "A healthcare company needs to deploy patient monitoring...",
    "options": [
      {"text": "Configure CloudWatch with custom metrics and SNS notifications", "isCorrect": true},
      {"text": "Implement real-time replication with hot standby and automated failover", "isCorrect": true},
      {"text": "Set up weekly backups to cold storage with manual recovery", "isCorrect": false},
      {"text": "Deploy read replicas without failover automation", "isCorrect": false}
    ],
    "correct_answer": null,
    "multiple_answers": "1",
    "correct_answers": ["Configure CloudWatch with custom metrics and SNS notifications", "Implement real-time replication with hot standby and automated failover"],
    "explanation": "Real-time patient monitoring requires both monitoring and failover capabilities. CloudWatch provides visibility while hot standby ensures availability.",
    "explanation_details": {
      "summary": "High-availability requirements for critical healthcare systems:",
      "breakdown": [
        "Real-time monitoring enables proactive issue detection",
        "Hot standby enables immediate failover (seconds vs minutes)",
        "Both monitoring and failover are required for critical systems"
      ],
      "otherOptions": "Weekly backups create unacceptable data loss risk\\nRead replicas without failover require manual intervention"
    },
    "domain": "${domain_name || 'Cloud Operations and Support'}",
    "subdomain": "${domain_name ? 'Disaster Recovery' : 'High Availability'}",
    "cognitive_level": "${cognitive_level || 'Application'}",
    "skill_level": "${skill_level || 'Intermediate'}",
    "weight": ${weight},
    "tags": [],
    "references": ["AWS Well-Architected Framework - Reliability Pillar", "AWS EC2 User Guide - High Availability", "CompTIA Cloud+ Study Guide - Disaster Recovery"]
  }
]` : `[
  {
    "question_text": "A healthcare company needs to deploy patient monitoring...",
    "options": [
      {"text": "Configure CloudWatch with custom metrics and SNS notifications", "isCorrect": false},
      {"text": "Implement real-time replication with hot standby and automated failover", "isCorrect": true},
      {"text": "Set up weekly backups to cold storage with manual recovery", "isCorrect": false},
      {"text": "Deploy read replicas without failover automation", "isCorrect": false}
    ],
    "correct_answer": "Implement real-time replication with hot standby and automated failover",
    "multiple_answers": null,
    "correct_answers": null,
    "explanation": "Real-time patient monitoring requires immediate failover capabilities. Hot standby with real-time replication ensures near-zero data loss and immediate recovery, critical for life-safety systems.",
    "explanation_details": {
      "summary": "High-availability requirements for critical healthcare systems:",
      "breakdown": [
        "Real-time replication prevents data loss during outages",
        "Hot standby enables immediate failover (seconds vs minutes)",
        "Automated failover reduces human error and response time",
        "Meets healthcare compliance requirements for system availability"
      ],
      "otherOptions": "CloudWatch monitoring alone doesn't provide failover\\nWeekly backups create unacceptable data loss risk\\nRead replicas without failover require manual intervention"
    },
    "domain": "${domain_name || 'Cloud Operations and Support'}",
    "subdomain": "${domain_name ? 'Disaster Recovery' : 'High Availability'}",
    "cognitive_level": "${cognitive_level || 'Application'}",
    "skill_level": "${skill_level || 'Intermediate'}",
    "weight": ${weight},
    "tags": [],
    "references": ["AWS Well-Architected Framework - Reliability Pillar", "AWS EC2 User Guide - High Availability", "CompTIA Cloud+ Study Guide - Disaster Recovery"]
  }
]`}

CRITICAL REMINDERS:
- correct_answer must be FULL TEXT, not a letter (A, B, C, D) or index (0, 1, 2, 3)
- correct_answers must be array of FULL TEXT strings or null
- multiple_answers must be null for single-answer questions or "1" (string) for multiple-answer questions
- explanation_details must have summary, breakdown (array), and otherOptions (string with \\n)
- options must have isCorrect boolean field
- references must be an array of strings (2-4 references) with official documentation sources, or null if none apply
${multiple_answers === '1' ? '- For multiple-answer questions: mark 2-3 options as "isCorrect": true, set correct_answer to null, and provide correct_answers array' : '- For single-answer questions: mark exactly ONE option as "isCorrect": true, set correct_answers to null, and provide correct_answer text'}
- Return ONLY valid JSON with no markdown code blocks or extra text`;

  return prompt;
}


module.exports = router;
module.exports.startBackgroundPolling = startBackgroundPolling;