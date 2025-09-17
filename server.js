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
