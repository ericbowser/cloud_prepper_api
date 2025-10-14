const {Client, Pool} = require('pg');
const getLogger = require("../logs/prepperLog");
const {DB_PORT, DB_HOST} = require("../env.json");
let _logger = getLogger();

let client = null;

async function connectLocalPostgres() {
	try {
		if (!client) {
			_logger.info('Connecting to local postgres..');
			client = new Client({
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: DB_HOST,
        port: DB_PORT,
        database: 'postgres',
				ssl: false
			});
			await client.connect();
		}

		return client;
	} catch (error) {
		_logger.error('Error connecting to local postgres: ', {error});
		throw error;
	}
}
async function connectLocalDockerPostgres() {
	try {
		if (!client) {
			client = new Client({
				connectionString: connectionString,
				ssl: false
			});
		}

		const pool = new Pool({
			user: 'postgres',
			host: 'localhost',
			password: DB_PASSWORD,
			database: 'postgres',
			port: 5432
		});
		client.pool = pool;
		console.log('pool: ', pool);

		return client;
	} catch (error) {
		_logger.error('Error connecting to local docker postgres: ', {error});
		throw error;
	}
}

module.exports = {connectLocalPostgres};