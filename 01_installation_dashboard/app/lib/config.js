const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

let appConfig = null;

function load(overridePath) {
  const configPath = overridePath || process.env.CONFIG_PATH
    || path.join(__dirname, '..', 'config.yaml');
  const raw = fs.readFileSync(configPath, 'utf8');
  appConfig = yaml.load(raw);
  return appConfig;
}

function get() {
  if (!appConfig) load();
  return appConfig;
}

module.exports = { load, get };
