'use strict';

const cron            = require('node-cron');
const labCommPoller   = require('../services/labCommPoller');
const newApplicationProposal = require('../services/newApplicationProposalService');
const declarationOrder = require('../services/declarationOrderService');
const draftEmail       = require('../services/draftEmailService');
const { LAB_COMM_POLL_CRON } = require('../config/constants');

// Cron for scanning the New Form → new-application proposals (ПИ+сумма+черновик ответа).
// Отдельный от lab-poll ритм; по умолчанию каждые 15 минут. Env: NEW_APP_SCAN_CRON.
const NEW_APP_SCAN_CRON = process.env.NEW_APP_SCAN_CRON || '*/15 * * * *';

// Cron for materializing Orders from «Декларация» + preparing lab-email drafts. По умолчанию
// раз в 20 минут (со сдвигом от new-app scan). Env: ORDER_SYNC_CRON.
const ORDER_SYNC_CRON = process.env.ORDER_SYNC_CRON || '*/20 * * * *';
// Cap on NEW lab-email drafts per run — не заваливать инбокс бэклогом с первого прогона.
const ORDER_SYNC_DRAFT_LIMIT = parseInt(process.env.ORDER_SYNC_DRAFT_LIMIT, 10) || 15;

// In-process lock: prevents a new poll from starting while one is still running.
// Sufficient for single-process deployment. If the process crashes mid-poll,
// the lock resets on restart automatically.
let _pollRunning = false;
let _scanRunning = false;
let _orderSyncRunning = false;

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

// Периодически сканировать Новую форму → предложения по новым заявкам. Output-only,
// идемпотентно; ошибки не роняют планировщик.
async function _runNewAppScan() {
  if (_scanRunning) { console.log('[scheduler] New-app scan skipped — previous run still in progress'); return; }
  _scanRunning = true;
  try {
    const r = await newApplicationProposal.generate({ limit: 25, newestFirst: true });
    if (r && (r.generated || r.reason)) {
      console.log(`[scheduler] New-app scan — created: ${r.generated || 0}, skipped: ${r.skipped || 0}${r.reason ? `, reason: ${r.reason}` : ''}`);
    }
  } catch (err) {
    console.error('[scheduler] New-app scan failed:', err.message);
  } finally {
    _scanRunning = false;
  }
}

// Материализовать заказы из «Декларации» в Mongo (пустая коллекция Order — причина, по
// которой письма-заявки лабораториям не появлялись в инбоксе; email-tasks-empty-orders), затем
// подготовить черновики писем. Всё output-only и gated: письма НЕ отправляются, статусы в листе
// не меняются. Ошибки не роняют планировщик.
async function _runOrderSync() {
  if (_orderSyncRunning) { console.log('[scheduler] Order sync skipped — previous run still in progress'); return; }
  _orderSyncRunning = true;
  try {
    const s = await declarationOrder.sync();
    const d = await draftEmail.generate({ limit: ORDER_SYNC_DRAFT_LIMIT });
    if ((s && (s.created || s.upserted)) || (d && d.generated)) {
      console.log(`[scheduler] Order sync — upserted: ${s.created}/${s.upserted} (new/total), lab-email drafts: ${d.generated}, skipped: ${d.skipped}`);
    }
  } catch (err) {
    console.error('[scheduler] Order sync failed:', err.message);
  } finally {
    _orderSyncRunning = false;
  }
}

function startScheduler() {
  const tz = process.env.SCHEDULER_TIMEZONE || 'UTC';

  if (cron.validate(LAB_COMM_POLL_CRON)) {
    cron.schedule(LAB_COMM_POLL_CRON, _runLabCommPoll, { timezone: tz });
    console.log(`[scheduler] Lab comm poll scheduled: ${LAB_COMM_POLL_CRON}`);
  } else {
    console.error(`[scheduler] Invalid LAB_COMM_POLL_CRON: "${LAB_COMM_POLL_CRON}". Lab poll not started.`);
  }

  if (cron.validate(NEW_APP_SCAN_CRON)) {
    cron.schedule(NEW_APP_SCAN_CRON, _runNewAppScan, { timezone: tz });
    console.log(`[scheduler] New-application scan scheduled: ${NEW_APP_SCAN_CRON}`);
  } else {
    console.error(`[scheduler] Invalid NEW_APP_SCAN_CRON: "${NEW_APP_SCAN_CRON}". New-app scan not started.`);
  }

  if (cron.validate(ORDER_SYNC_CRON)) {
    cron.schedule(ORDER_SYNC_CRON, _runOrderSync, { timezone: tz });
    console.log(`[scheduler] Order sync scheduled: ${ORDER_SYNC_CRON}`);
  } else {
    console.error(`[scheduler] Invalid ORDER_SYNC_CRON: "${ORDER_SYNC_CRON}". Order sync not started.`);
  }
}

// Manual trigger — used by POST /api/integrations/scheduler/run (Phase 8)
async function runNow() {
  return _runLabCommPoll();
}

module.exports = { startScheduler, runNow };
