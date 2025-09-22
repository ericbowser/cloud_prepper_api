const express = require('express');
const cors = require('cors');
const router = express.Router();
const {json} = require('body-parser');
const {connectLocalPostgres} = require('./documentdb/client');
const {sendEmailWithAttachment} = require('./email/SendEmail');
const logger = require('./logs/prepperLog');
const swaggerUi = require('swagger-ui-express');
const openapiSpecification = require('./swagger');

let _logger = logger();
_logger.info('Logger Initialized');

router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpecification));
router.use(json());
router.use(cors());
router.use(express.json());
router.use(express.urlencoded({extended: true}));

/**
 * @swagger
 * /getExamQuestions:
 *   get:
 *     summary: Retrieve exam questions
 *     description: Fetches exam questions for CompTIA Cloud+ and AWS Certified Architect Associate.
 *     responses:
 *       200:
 *         description: A JSON object containing arrays of questions.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comptiaQuestions:
 *                   type: array
 *                   items:
 *                     type: object
 *                 awsQuestions:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: Server error.
 */

router.put('/updateQuestion/:id', async (req, res) => {
  const data = {question_id};
  try {
    _logger.info("Fetching existing question");
    const ps = await connectLocalPostgres();
    const update = await ps.query("SELECT * FROM prepper.comptia_cloud_plus_questions where question_id = ${0}");
    const values = [
      questionData.category,
      questionData.difficulty,
      questionData.domain,
      questionData.question_text,
      optionsJson,
      questionData.correct_answer,
      questionData.explanation,
      explanationDetailsJson,
      questionData.multiple_answers ? 1 : null,
      questionData.multiple_answers ?
        `{${questionData.correct_answers.map(ans => `"${ans}"`).join(',')}}` :
        null
    ];
    const result = await ps.query(update, values);
    if (result) {
      _logger.info("Success");
      return res.status(200).send(result);
    }
    
    return res.status(500).send().end();
  } catch (error) {
    _logger.error('Error updating question: ', {error});
    res.status(500).send("Error").end();
  } finally {
    ps.dispose();
  }
});

router.get('/getExamQuestions', async (req, res) => {
  const data = {};
  try {
    _logger.info("Fetching questions..");
    const ps = await connectLocalPostgres();
    const comptia = await ps.query("SELECT * FROM prepper.comptia_cloud_plus_questions order by domain");
    _logger.info("number of rows returned for comptia: ", {rows: comptia.rows.length});
    if (comptia.rows.length > 0) {
      data.comptiaQuestions = comptia.rows
    }
    const aws = await ps.query("SELECT * FROM prepper.aws_certified_architect_associate_questions order by domain");
    _logger.info("number of rows returned for aws: ", {rows: aws.rows.length});
    if (aws.rows.length > 0) {
      data.awsQuestions = aws.rows
    }

    return res.status(200).send(data).end();
  } catch (error) {

    _logger.error('Error fetching questions: ', {error});
    res.status(500).json({message: 'Failed to send email.'});
  } finally {
    ps.dispose();
  }
});
router.post('/addQuestion', async (req, res) => {
  const questionData = {
    category,
    difficulty,
    domain,
    question_text,
    options,
    correct_answer,
    explanation,
    explanation_details,
    multiple_answers,
    correct_answers
  } = req.body.question;
  try {
    // Determine which table to insert into
    const tableName = questionData.certification === 'aws'
      ? 'aws_certified_architect_associate_questions'
      : 'comptia_cloud_plus_questions';

    // Format options as JSON string for PostgreSQL
    const optionsJson = JSON.stringify(questionData.options);
    const explanationDetailsJson = JSON.stringify(questionData.explanation_details);

    _logger.info("Adding question id {0}", {...req.body});
    const ps = await connectLocalPostgres();
    // Use your sequences for auto-generated IDs
    const query = `
        INSERT INTO prepper.${tableName}(category, difficulty, domain, question_text, options,
                                          correct_answer, explanation, explanation_details,
                                          multiple_answers, correct_answers)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `;
    const values = [
      questionData.category,
      questionData.difficulty,
      questionData.domain,
      questionData.question_text,
      optionsJson,
      questionData.correct_answer,
      questionData.explanation,
      explanationDetailsJson,
      questionData.multiple_answers ? 1 : null,
      questionData.multiple_answers ?
        `{${questionData.correct_answers.map(ans => `"${ans}"`).join(',')}}` :
        null
    ];

    const result = await ps.query(query, values);
    res.status(201).json({
      success: true,
      question: result.rows[0],
      message: 'Question added successfully'
    });

    _logger.info("Inserted new question: {0}", {question_text});

    return res.status(200).send({ok:true}).end();
  } catch (error) {
    _logger.error('Error fetching questions: ', {error});
    res.status(500).json({message: 'Failed to send email.'});
  } finally {
    ps.dispose();
  }
});

/**
 * @swagger
 * /sendEmail:
 *   post:
 *     summary: Send an email
 *     description: Sends an email with the provided details.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               subject:
 *                 type: string
 *               message:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email sent successfully.
 *       500:
 *         description: Failed to send email.
 */
router.post('/sendEmail', async (req, res) => {
  const {name, email, subject, message} = req.body;

  try {
    _logger.info("Sending email: ", {name, email, subject, message});
    const messageId = await sendEmailWithAttachment(name, email, subject, message);
    _logger.info("Email sent with message id: ", {messageId})
    res.status(200).send('Email Sent!').end();
  } catch (error) {
    _logger.error('Error sending email: ', {error});
    res.status(500).json({message: 'Failed to send email.'});
  }
});

module.exports = router;
