'use strict';

const fs = require('fs');
const path = require('path');

const ENV_PATH = process.env.ENV_PATH || path.resolve('./.env');

function parseEnv(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1);
    // keep raw value (no unescaping)
    out[k] = v;
  }
  return out;
}

function serializeEnv(map, originalText) {
  const origLines = String(originalText || '').split(/\r?\n/);
  const seen = new Set();
  const outLines = [];

  for (const line of origLines) {
    if (!line || /^\s*#/.test(line) || line.indexOf('=') === -1) {
      outLines.push(line);
      continue;
    }
    const idx = line.indexOf('=');
    const k = line.slice(0, idx).trim();
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      outLines.push(`${k}=${map[k]}`);
      seen.add(k);
    } else {
      outLines.push(line);
    }
  }

  // append any new keys
  for (const [k, v] of Object.entries(map)) {
    if (!seen.has(k)) outLines.push(`${k}=${v}`);
  }

  // trim trailing blank lines but keep final newline
  while (outLines.length && outLines[outLines.length - 1] === '') outLines.pop();
  return outLines.join('\n') + '\n';
}

function readEnvFile() {
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    return { raw, map: parseEnv(raw) };
  } catch {
    return { raw: '', map: {} };
  }
}

function writeEnvKey(key, value) {
  const { raw, map } = readEnvFile();
  map[key] = String(value);
  const next = serializeEnv(map, raw);
  fs.writeFileSync(ENV_PATH, next, 'utf8');
  return { path: ENV_PATH, map };
}

function getEnvKey(key) {
  const { map } = readEnvFile();
  return map[key];
}

module.exports = { ENV_PATH, readEnvFile, writeEnvKey, getEnvKey };
