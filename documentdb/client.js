const { Client, Pool } = require("pg");
const getLogger = require("../logs/prepperLog");
const config = require("../config");
let _logger = getLogger();

let client = null;

async function connectLocalPostgres() {
  try {
    if (!client) {
      _logger.info("Connecting to local postgres..");
      client = new Client({
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        host: config.DB_HOST,
        port: parseInt(config.DB_PORT),
        database: 'ericbo',
        ssl: false,
      });
      await client.connect();
    }

    return client;
  } catch (error) {
    _logger.error("Error connecting to local postgres: ", { error });
    throw error;
  }
}
async function connectLocalDockerPostgres() {
  try {
    if (!client) {
      client = new Client({
        connectionString: connectionString,
        ssl: false,
      });
    }

    const pool = new Pool({
      user: config.DB_USER,
      host: config.DB_HOST,
      password: config.DB_PASSWORD,
      database: "postgres",
      port: parseInt(config.DB_PORT),
    });
    client.pool = pool;
    console.log("pool: ", pool);

    return client;
  } catch (error) {
    _logger.error("Error connecting to local docker postgres: ", { error });
    throw error;
  }
}

module.exports = { connectLocalPostgres };
