const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Cloud Prepper API',
      version: '1.0.0',
      description: 'A Node.js back-end for cloud prepper',
    },
    servers: [
      {
        url: 'http://localhost:36236/api',
        description: 'Development server',
      },
    ],
  },
  apis: ['./server.js', './routes/backup.js', './routes/auth.js'], // files containing annotations
};

const openapiSpecification = swaggerJsdoc(options);

module.exports = openapiSpecification;
