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

let ps = null;

router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpecification));
router.use(json());
router.use(cors());
router.use(express.json());
router.use(express.urlencoded({extended: true}));

/**
 * @swagger
 * /updateQuestion/{id}:
 *   put:
 *     summary: Update an existing question
 *     description: Updates a question by ID in either CompTIA Cloud+ or AWS Certified Architect Associate tables.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The question ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               certification:
 *                 type: string
 *                 enum: [aws, comptia]
 *                 description: Optional - specify which table to update (aws or comptia)
 *               category:
 *                 type: string
 *               difficulty:
 *                 type: string
 *               domain:
 *                 type: string
 *               question_text:
 *                 type: string
 *               options:
 *                 type: array
 *                 items:
 *                   type: string
 *               correct_answer:
 *                 type: string
 *               explanation:
 *                 type: string
 *               explanation_details:
 *                 type: object
 *               multiple_answers:
 *                 type: boolean
 *               correct_answers:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Question updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 question:
 *                   type: object
 *                 message:
 *                   type: string
 *       400:
 *         description: Bad request - No fields provided for update
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 * 
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
  try {
    const questionId = req.params.id;
    const questionData = req.body.question;
    
    _logger.info("Updating question with ID: ", {questionId});
    if (!ps) {
      ps = await connectLocalPostgres();
    }
    
    // Determine which table based on certification or default to checking both
    let tableName;
    if (questionData.certification === 'aws') {
      tableName = 'aws_certified_architect_associate_questions';
    } else if (questionData.certification === 'comptia') {
      tableName = 'comptia_cloud_plus_questions';
    } else {
      // If certification not provided, we need to find which table has this ID
      const comptiaCheck = await ps.query('SELECT id FROM prepper.comptia_cloud_plus_questions WHERE id = $1', [questionId]);
      const awsCheck = await ps.query('SELECT id FROM prepper.aws_certified_architect_associate_questions WHERE id = $1', [questionId]);
      
      if (comptiaCheck.rows.length > 0) {
        tableName = 'comptia_cloud_plus_questions';
      } else if (awsCheck.rows.length > 0) {
        tableName = 'aws_certified_architect_associate_questions';
      } else {
        return res.status(404).json({message: 'Question not found'});
      }
    }

    // Format options and explanation_details as JSON if provided
    const optionsJson = questionData.options ? JSON.stringify(questionData.options) : null;
    const explanationDetailsJson = questionData.explanation_details ? JSON.stringify(questionData.explanation_details) : null;
    
    // Build dynamic update query based on provided fields
    const updateFields = [];
    const values = [];
    let paramIndex = 1;
    
    if (questionData.category !== undefined) {
      updateFields.push(`category = $${paramIndex++}`);
      values.push(questionData.category);
    }
    if (questionData.difficulty !== undefined) {
      updateFields.push(`difficulty = $${paramIndex++}`);
      values.push(questionData.difficulty);
    }
    if (questionData.domain !== undefined) {
      updateFields.push(`domain = $${paramIndex++}`);
      values.push(questionData.domain);
    }
    if (questionData.question_text !== undefined) {
      updateFields.push(`question_text = $${paramIndex++}`);
      values.push(questionData.question_text);
    }
    if (questionData.options !== undefined) {
      updateFields.push(`options = $${paramIndex++}`);
      values.push(optionsJson);
    }
    if (questionData.correct_answer !== undefined) {
      updateFields.push(`correct_answer = $${paramIndex++}`);
      values.push(questionData.correct_answer);
    }
    if (questionData.explanation !== undefined) {
      updateFields.push(`explanation = $${paramIndex++}`);
      values.push(questionData.explanation);
    }
    if (questionData.explanation_details !== undefined) {
      updateFields.push(`explanation_details = $${paramIndex++}`);
      values.push(explanationDetailsJson);
    }
    if (questionData.multiple_answers !== undefined) {
      updateFields.push(`multiple_answers = $${paramIndex++}`);
      values.push(questionData.multiple_answers ? 1 : null);
    }
    if (questionData.correct_answers !== undefined) {
      updateFields.push(`correct_answers = $${paramIndex++}`);
      values.push(questionData.multiple_answers ?
        `{${questionData.correct_answers.map(ans => `"${ans}"`).join(',')}}` :
        null);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({message: 'No fields provided for update'});
    }
    
    // Add the ID parameter at the end
    values.push(questionId);
    
    const updateQuery = `
      UPDATE prepper.${tableName}
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;
    
    const result = await ps.query(updateQuery, values);
    _logger.info('Updated question: ', {result});
    
    if (result.rows.length === 0) {
      return res.status(404).json({message: 'Question not found'});
    }
    
    _logger.info("Successfully updated question: ", {id: questionId});
    
    const data = {
      'ok': true,
      success: true,
      question: result.rows[0],
      message: 'Question updated successfully'
    };
    
    return res.status(201).send({...data}).end();
  } catch (error) {
    _logger.error('Error updating question: ', {error});
    res.status(500).json({message: 'Failed to update question'});
  }
});

router.get('/getExamQuestions', async (req, res) => {
  const data = {};
  try {
    _logger.info("Fetching questions..");

    if (!ps) {
      ps = await connectLocalPostgres();
    }
    const comptia = await ps.query("SELECT * FROM prepper.comptia_cloud_plus_questions order by id ASC");
    
    _logger.info("number of rows returned for comptia: ", {rows: comptia.rows.length});
    
    if (comptia.rows.length > 0) {
      data.comptiaQuestions = comptia.rows
    } else {
      return res.status(404).send({message: 'Failed to get questions...'}).end();
    }
    
    const aws = await ps.query("SELECT * FROM prepper.aws_certified_architect_associate_questions order by id ASC");
    _logger.info("number of rows returned for aws: ", {rows: aws.rows.length});
    if (aws.rows.length > 0) {
      data.awsQuestions = aws.rows
    }

    return res.status(201).send({
      'ok': true,
      ...data
    }).end();
  } catch (error) {

    _logger.error('Error fetching questions: ', {error});
    res.status(500).json({message: error.message});
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
    if (!ps) {
      ps = await connectLocalPostgres();
    }
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
    _logger.info("Inserted new question: {0}", {'question_text': result.rows[0].question_text});
    res.status(201).send({
      success: true,
      question: result.rows[0],
      message: 'Question added successfully'
    }).end();
  } catch (error) {
    _logger.error('Error fetching questions: ', {error});
    res.status(500).json({message: 'Failed to send email.'});
  }
});

/**
 * @swagger
 * /deleteQuestion/{id}:
 *   delete:
 *     summary: Delete a question
 *     description: Deletes a question by ID from either CompTIA Cloud+ or AWS Certified Architect Associate tables.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: The question ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               certification:
 *                 type: string
 *                 enum: [aws, comptia]
 *                 description: Optional - specify which table to delete from (aws or comptia)
 *     responses:
 *       200:
 *         description: Question deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 deletedQuestion:
 *                   type: object
 *       404:
 *         description: Question not found
 *       500:
 *         description: Server error
 */
router.delete('/deleteQuestion/:id', async (req, res) => {
  try {
    const questionId = req.params.id;
    const { certification } = req.body || {};

    _logger.info("Deleting question with ID: ", {questionId});
    if (!ps) {
      ps = await connectLocalPostgres();
    }

    // Determine which table based on certification or default to checking both
    let tableName;
    let questionToDelete = null;

    if (certification === 'aws') {
      tableName = 'aws_certified_architect_associate_questions';
    } else if (certification === 'comptia') {
      tableName = 'comptia_cloud_plus_questions';
    } else {
      // If certification not provided, we need to find which table has this ID
      const comptiaCheck = await ps.query('SELECT * FROM prepper.comptia_cloud_plus_questions WHERE id = $1', [questionId]);
      const awsCheck = await ps.query('SELECT * FROM prepper.aws_certified_architect_associate_questions WHERE id = $1', [questionId]);

      if (comptiaCheck.rows.length > 0) {
        tableName = 'comptia_cloud_plus_questions';
        questionToDelete = comptiaCheck.rows[0];
      } else if (awsCheck.rows.length > 0) {
        tableName = 'aws_certified_architect_associate_questions';
        questionToDelete = awsCheck.rows[0];
      } else {
        return res.status(404).json({message: 'Question not found'});
      }
    }

    // If we haven't found the question yet (when certification was specified), get it before deleting
    if (!questionToDelete) {
      const questionQuery = await ps.query(`SELECT * FROM prepper.${tableName} WHERE id = $1`, [questionId]);
      if (questionQuery.rows.length === 0) {
        return res.status(404).json({message: 'Question not found'});
      }
      questionToDelete = questionQuery.rows[0];
    }

    // Delete the question
    const deleteQuery = `DELETE FROM prepper.${tableName} WHERE id = $1 RETURNING *`;
    const result = await ps.query(deleteQuery, [questionId]);

    if (result.rows.length === 0) {
      return res.status(404).json({message: 'Question not found'});
    }

    _logger.info("Successfully deleted question: ", {id: questionId, table: tableName});
    return res.status(200).json({
      success: true,
      message: 'Question deleted successfully',
      deletedQuestion: questionToDelete
    });

  } catch (error) {
    _logger.error('Error deleting question: ', {error});
    res.status(500).json({message: 'Failed to delete question'});
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
