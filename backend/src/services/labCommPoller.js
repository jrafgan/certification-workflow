'use strict';

const { LabCommThread } = require('../models/LabCommThread');
const gmailClient       = require('../integrations/gmailClient');
const taskService       = require('./taskService');
const eventService      = require('./eventService');
const workflowDetectionService = require('./workflowDetectionService');
const {
  LAB_COMM_MAX_CONSECUTIVE_ERRORS,
  LAB_COMM_BATCH_DELAY_MS,
  LAB_COMM_AUTO_REPLY_SUBJECTS,
  EVENT_TYPES,
} = require('../config/constants');

// ─── Auto-reply detection ─────────────────────────────────────────────────────

function isAutoReply(message) {
  const headers = message.payload?.headers || [];

  // RFC 3834 header
  const autoSubmitted = gmailClient.extractHeader(headers, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;

  // Non-standard header used by some mail servers
  if (gmailClient.extractHeader(headers, 'x-autoreply')) return true;

  const subject = (gmailClient.extractHeader(headers, 'subject') || '').toLowerCase();
  return LAB_COMM_AUTO_REPLY_SUBJECTS.some(
    prefix => subject.startsWith(prefix.toLowerCase())
  );
}

// ─── Poll one thread ──────────────────────────────────────────────────────────

async function pollThread(thread) {
  try {
    // 'full' format: needed for headers (auto-reply check) and payload parts (attachments)
    const gmailThread = await gmailClient.getThread(thread.thread_id, 'full');
    const messages    = gmailThread.messages || [];
    const currentCount = messages.length;

    const lastKnown = thread.last_known_message_count ?? thread.initialized_message_count ?? 0;
    const now       = new Date();

    thread.last_checked_at    = now;
    thread.error_count        = 0;
    thread.last_error_at      = undefined;
    thread.last_error_message = undefined;

    if (currentCount <= lastKnown) {
      thread.last_known_message_count = currentCount;
      await thread.save();
      return { replied: false };
    }

    // Inspect only the new messages since last poll
    const newMessages  = messages.slice(lastKnown);
    let newAutoReplies = 0;
    let replyMessage   = null;

    for (const msg of newMessages) {
      if (isAutoReply(msg)) {
        newAutoReplies++;
      } else if (!replyMessage) {
        replyMessage = msg;
      }
    }

    thread.last_known_message_count = currentCount;
    thread.auto_reply_count         = (thread.auto_reply_count || 0) + newAutoReplies;

    if (!replyMessage) {
      await thread.save();
      return { replied: false };
    }

    // ── Real reply detected ───────────────────────────────────────────────────
    const headers  = replyMessage.payload?.headers || [];
    const hasAttachment = gmailClient.messageHasAttachment(replyMessage);

    thread.status             = 'replied';
    thread.reply_detected_at  = now;
    thread.reply_has_attachment = hasAttachment;
    thread.reply_sender       = gmailClient.extractHeader(headers, 'from') || undefined;

    await thread.save();

    const attachNote = hasAttachment ? ' with attachment' : '';
    const priority   = hasAttachment ? 'high' : 'medium';

    await taskService.createTask(
      thread.order_id,
      'manual',
      `Lab reply received${attachNote} — review and process`,
      priority,
      now,
      'auto'
    );

    await eventService.appendEvent(thread.order_id, {
      type:        EVENT_TYPES.LAB_THREAD_REPLY_DETECTED,
      description: `Reply detected in Gmail thread ${thread.thread_id}${attachNote}`,
      actor:       'system',
    });

    if (hasAttachment) {
      await eventService.appendEvent(thread.order_id, {
        type:        EVENT_TYPES.LAB_THREAD_ATTACHMENT_DETECTED,
        description: `Attachment detected in lab reply (thread: ${thread.thread_id})`,
        actor:       'system',
      });
    }

    // Workflow event detection (layout/original) from the lab reply. Proposes a
    // recommendation only; never changes order state. Must not break polling.
    try {
      await workflowDetectionService.detectFromMessage(
        thread.order_id, thread.thread_id, replyMessage
      );
    } catch (_err) {
      // Detection failure is non-fatal — the reply task/event are already recorded.
    }

    return { replied: true, hasAttachment };

  } catch (err) {
    thread.error_count        = (thread.error_count || 0) + 1;
    thread.last_error_at      = new Date();
    thread.last_error_message = String(err.message || err).slice(0, 200);
    thread.last_checked_at    = new Date();

    if (thread.error_count >= LAB_COMM_MAX_CONSECUTIVE_ERRORS) {
      thread.status = 'unreachable';
    }

    try { await thread.save(); } catch (_) { /* save failure surfaced to caller */ }

    return { replied: false, error: err.message };
  }
}

// ─── Timeout check ────────────────────────────────────────────────────────────
// Runs before the poll loop. Marks waiting threads whose deadline has passed.

async function checkTimeouts() {
  const now     = new Date();
  const threads = await LabCommThread.find({
    status:     'waiting',
    timeout_at: { $exists: true, $ne: null, $lte: now },
  });

  let count = 0;
  for (const thread of threads) {
    thread.status = 'timed_out';
    await thread.save();

    await taskService.createTask(
      thread.order_id,
      'remind_lab',
      `Lab has not responded — deadline passed. Send a reminder.`,
      'high',
      now,
      'auto'
    );

    await eventService.appendEvent(thread.order_id, {
      type:        EVENT_TYPES.LAB_THREAD_TIMED_OUT,
      description: `Thread ${thread.thread_id} timed out — no reply received by deadline`,
      actor:       'system',
    });

    count++;
  }

  return count;
}

// ─── Main poll run ────────────────────────────────────────────────────────────

async function runPoll() {
  // Timeout check first — no point polling a thread that already missed its deadline
  const timedOut = await checkTimeouts();

  // Fetch the batch of waiting threads, least-recently-checked first
  const threads = await LabCommThread
    .find({ status: 'waiting' })
    .sort({ last_checked_at: 1 })
    .limit(50);

  if (threads.length === 0) {
    return { checked: 0, replied: 0, errors: 0, timedOut };
  }

  let replied = 0;
  let errors  = 0;

  for (const thread of threads) {
    const result = await pollThread(thread);
    if (result.replied)  replied++;
    if (result.error)    errors++;

    if (LAB_COMM_BATCH_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, LAB_COMM_BATCH_DELAY_MS));
    }
  }

  return { checked: threads.length, replied, errors, timedOut };
}

module.exports = { runPoll, pollThread, checkTimeouts };
