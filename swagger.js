const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Cloud Prepper API',
      version: '1.0.0',
      description: 'A Node.js back-end for cloud prepper',
    },
  },
  apis: ['./server.js'], // files containing annotations as above
};

const openapiSpecification = swaggerJsdoc(options);

module.exports = openapiSpecification;
