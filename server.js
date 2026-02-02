// --- server.js ---
'use strict';

// Load .env if present (dashboard-controlled vars)
require('dotenv').config();

const path = require('path');
const express = require('express');

const dashboardRoutes = require('./src/routes/dashboard');
const scheduler = require('./src/lib/scheduler');

const app = express();

// View engine (Pug)
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Static assets
app.use('/public', express.static(path.join(__dirname, 'public')));

// Routes
app.use('/', dashboardRoutes);

// Start scheduler background loop so the server runs scans based on dashboard delay
scheduler.startBackgroundLoop();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[dashboard] listening on http://localhost:${port}`);
});
