const server = require('./server');
const http = require("node:http");
const logger = require('./logs/prepperLog');
const _logger = logger();
_logger.info('Starting Cloud Prepper API');
const config = require("./config");
const dotenv = require('dotenv').config();
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const openapiSpecification = require("./swagger");

const httpPort = config.PORT || 3003;
console.log('passed port to use for http', httpPort);

const app = express();
app.use(express.json());
app.use(express.urlencoded({extended: true}));

// CORS middleware
const cors = require('cors');
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Mount API routes
app.use('/api', server);

// Also provide route at root level for backward compatibility
// Import the handler logic directly
const { connectLocalPostgres } = require('./documentdb/client');
let ps = null;

app.get('/getExamQuestions', async (req, res) => {
    const data = {};
    const logger = require('./logs/prepperLog');
    const _logger = logger();
    
    try {
        _logger.info("Fetching questions (root route)..");

        // Connect to database
        if (!ps || ps._ending) {
            _logger.info("Establishing database connection...");
            ps = await connectLocalPostgres();
        }
        
        // Test connection
        await ps.query('SELECT 1');
        _logger.info("Database connection verified");
        
        // Fetch CompTIA questions
        _logger.info("Querying CompTIA questions...");
        const comptia = await ps.query("SELECT * FROM prepper.comptia_cloud_plus_questions ORDER BY id ASC");
        _logger.info("number of rows returned for comptia: ", {rows: comptia.rows.length});
        
        if (comptia.rows.length > 0) {
            data.comptiaQuestions = comptia.rows;
        } else {
            data.comptiaQuestions = [];
            _logger.warn("No CompTIA questions found");
        }
        
        // Fetch AWS questions
        _logger.info("Querying AWS questions...");
        const aws = await ps.query("SELECT * FROM prepper.aws_certified_architect_associate_questions ORDER BY id ASC");
        _logger.info("number of rows returned for aws: ", {rows: aws.rows.length});
        
        if (aws.rows.length > 0) {
            data.awsQuestions = aws.rows;
        } else {
            data.awsQuestions = [];
            _logger.warn("No AWS questions found");
        }

        // Return success even if one or both are empty
        if (data.comptiaQuestions.length === 0 && data.awsQuestions.length === 0) {
            _logger.warn("No questions found in either table");
            return res.status(200).json({
                ok: true,
                message: 'No questions found in database',
                comptiaQuestions: [],
                awsQuestions: []
            });
        }

        _logger.info("Successfully fetched questions", {
            comptiaCount: data.comptiaQuestions.length,
            awsCount: data.awsQuestions.length
        });

        return res.status(200).json({
            ok: true,
            ...data
        });
    } catch (error) {
        _logger.error('Error fetching questions: ', {
            error: error.message, 
            stack: error.stack,
            name: error.name,
            code: error.code
        });
        
        // Reset connection on error
        if (ps && !ps._ending) {
            try {
                await ps.end();
            } catch (e) {
                _logger.error("Error closing connection: ", {error: e.message});
            }
            ps = null;
        }
        
        res.status(500).json({
            ok: false,
            message: 'Failed to fetch questions',
            error: error.message,
            code: error.code
        });
    }
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpecification))

const httpServer = http.createServer(app);
httpServer.listen(httpPort, () => {
    console.log(`Server listening on http://localhost:${httpPort}`);
    console.log(`Swagger UI available at http://localhost:${httpPort}/api-docs`);
    
    // Launch Chrome externally to open Swagger UI
    const { exec } = require('child_process');
    const swaggerUrl = `http://localhost:${httpPort}/api-docs`;
    
    // Detect OS and launch Chrome accordingly
    const platform = process.platform;
    let chromeCommand;
    
    if (platform === 'win32') {
        // Windows - try common Chrome paths
        const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
        ];
        
        // Try to find Chrome, or use start command
        const fs = require('fs');
        let chromePath = null;
        for (const path of chromePaths) {
            if (fs.existsSync(path)) {
                chromePath = path;
                break;
            }
        }
        
        if (chromePath) {
            chromeCommand = `"${chromePath}" "${swaggerUrl}"`;
        } else {
            // Fallback to start command (Windows will use default browser)
            chromeCommand = `start chrome "${swaggerUrl}"`;
        }
    } else if (platform === 'darwin') {
        // macOS
        chromeCommand = `open -a "Google Chrome" "${swaggerUrl}"`;
    } else {
        // Linux
        chromeCommand = `google-chrome "${swaggerUrl}" || chromium-browser "${swaggerUrl}" || xdg-open "${swaggerUrl}"`;
    }
    
    // Execute Chrome launch command
    exec(chromeCommand, (error) => {
        if (error) {
            _logger.warn('Could not automatically open Chrome. Please manually navigate to:', swaggerUrl);
            console.log(`\n📖 Please open your browser and navigate to: ${swaggerUrl}\n`);
        } else {
            console.log(`\n🌐 Opening Swagger UI in Chrome: ${swaggerUrl}\n`);
        }
    });
});

