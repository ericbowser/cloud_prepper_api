const server = require('./server');
const http = require("node:http");
const logger = require('./logs/prepperLog');
const _logger = logger();
_logger.info('Starting Cloud Prepper API');
const {PORT} = require("./env.json");

const express = require("express");

const httpPort = PORT || 3003;
console.log('passed port to use for http', httpPort);

const app = express();
app.use(server);
app.use(express.json());
app.use(express.urlencoded({extended: true}));

const httpServer = http.createServer(app);
httpServer.listen(httpPort, () => {
    console.log(`Server listening on http://localhost:${httpPort}`);
});

