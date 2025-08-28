const express = require('express');
const app = express();
const cors = require('cors');
const router = express.Router();
const logger = require('./logs/prepper');
const {json} = require('body-parser');
const {connectLocalPostgres} = require('./documentdb/client');

let _logger = logger();
_logger.info('Logger Initialized');

router.use(json());
router.use(cors());
router.use(express.json());
router.use(express.urlencoded({extended: true}));

router.get('/getExamQuestions', async (req, res) => {
  const data = {};
  try {
    _logger.info("Fetching questions..");
    const ps = await connectLocalPostgres();
    const comptia = await ps.query("SELECT * FROM prepper.comptia_cloud_plus_questions");
    _logger.info("number of rows returned for comptia: ", {rows: comptia.rows.length});
    if (comptia.rows.length > 0) {
      data.comptiaQuestions = comptia.rows
    }
    const aws = await ps.query("SELECT * FROM prepper.aws_certified_architect_associate_questions");
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

module.exports = router;
