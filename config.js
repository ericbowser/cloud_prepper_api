// config.js - Reads configuration from JSON file (env.json)
// Simple JSON import - no external dependencies needed
const fs = require('fs');
const path = require('path');

let config = {};

// Read from env.json (JSON format - easiest to import and manage)
//const envJsonPath = path.join(__dirname, '.env');
/*if (fs.existsSync(envJsonPath)) {
  try {
    config = JSON.parse(fs.readFileSync(envJsonPath, 'utf8'));
  } catch (error) {
    console.warn('Warning: Could not parse .env:', error.message);
  }
}*/

// Helper function to get config value with optional default
function getConfig(key, defaultValue = null) {
  // First check process.env (for Docker/override), then JSON config
  return process.env[key] || config[key] || defaultValue;
}

// Export commonly used config values
module.exports = {
  // Server config
  PORT: getConfig('PORT', '36236'),
  HOST: getConfig('HOST', 'localhost'),
  
  // Database config
  DB_HOST: getConfig('DB_HOST', process.env.DB_HOST),
  DB_PORT: getConfig('DB_PORT', process.env.DB_PORT),
  DB_USER: getConfig('DB_USER', process.env.DB_USER),
  DB_PASSWORD: getConfig('DB_PASSWORD', process.env.DB_PASSWORD),
  
  // Email config
  GMAIL_APP_PASSWORD: getConfig('GMAIL_APP_PASSWORD', ''),
  
  // Generic getter
  get: getConfig,
  
  // Get all config
  getAll: () => ({ ...config, ...process.env })
};

