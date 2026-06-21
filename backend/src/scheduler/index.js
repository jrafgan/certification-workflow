'use strict';

const cron            = require('node-cron');
const labCommPoller   = require('../services/labCommPoller');
const { LAB_COMM_POLL_CRON } = require('../config/constants');

// In-process lock: prevents a new poll from starting while one is still running.
// Sufficient for single-process deployment. If the process crashes mid-poll,
// the lock resets on restart automatically.
let _pollRunning = false;

async function _runLabCommPoll() {
  if (_pollRunning) {
    console.log('[scheduler] Lab comm poll skipped — previous run still in progress');
    return;
  }

  _pollRunning = true;
  const start  = Date.now();

  try {
    const result  = await labCommPoller.runPoll();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[scheduler] Poll complete in ${elapsed}s` +
      ` — checked: ${result.checked}` +
      `, replied: ${result.replied}` +
      `, timed_out: ${result.timedOut}` +
      `, errors: ${result.errors}`
    );
  } catch (err) {
    console.error('[scheduler] Poll run failed:', err.message);
  } finally {
    _pollRunning = false;
  }
}

function startScheduler() {
  if (!cron.validate(LAB_COMM_POLL_CRON)) {
    console.error(
      `[scheduler] Invalid LAB_COMM_POLL_CRON: "${LAB_COMM_POLL_CRON}". Scheduler not started.`
    );
    return;
  }

  cron.schedule(LAB_COMM_POLL_CRON, _runLabCommPoll, {
    timezone: process.env.SCHEDULER_TIMEZONE || 'UTC',
  });

  console.log(`[scheduler] Lab comm poll scheduled: ${LAB_COMM_POLL_CRON}`);
}

// Manual trigger — used by POST /api/integrations/scheduler/run (Phase 8)
async function runNow() {
  return _runLabCommPoll();
}

module.exports = { startScheduler, runNow };
