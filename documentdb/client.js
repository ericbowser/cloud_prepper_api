const {Client, Pool} = require('pg');
const getLogger = require("../logs/prepperLog");
const {DB_PASSWORD, DB_PORT, DB_SERVER, DB_USER} = require("../env.json");
let _logger = getLogger();

let client = null;

const connectionString =
	`postgres://${DB_USER}:${DB_PASSWORD}@${DB_SERVER}:${DB_PORT}/postgres`;

async function connectLocalPostgres() {
	try {
		if (!client) {
			_logger.info('Connecting to local postgres..');
			client = new Client({
				connectionString: connectionString,
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