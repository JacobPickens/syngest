// --- src/lib/db.js ---
'use strict';

const sqlite3 = require('sqlite3');
const crypto = require('crypto');

function openDb(dbPath) {
  return new sqlite3.Database(dbPath);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch { resolve(); }
  });
}

async function tableExists(db, tableName) {
  const name = String(tableName || '');
  if (!name) return false;
  const row = await get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name]).catch(() => null);
  return !!(row && row.name);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

module.exports = {
  openDb,
  run,
  get,
  all,
  closeDb,
  tableExists,
  sha256
};
