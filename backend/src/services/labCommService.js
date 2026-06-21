'use strict';

const { LabCommThread } = require('../models/LabCommThread');
const { Order }         = require('../models/Order');
const taskService       = require('./taskService');
const eventService      = require('./eventService');
const gmailClient       = require('../integrations/gmailClient');
const errorUtils        = require('../utils/errorUtils');
const {
  EVENT_TYPES,
  LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS,
  LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS,
  LAB_COMM_MAX_CONSECUTIVE_ERRORS,
  LAB_COMM_RISK_HIGH_REPLY_HOURS,
  LAB_COMM_RISK_CRITICAL_REPLY_HOURS,
  LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS,
} = require('../config/constants');

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY  = 86_400_000;

// ─── Risk ordering ────────────────────────────────────────────────────────────

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function maxRisk(a, b) {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

// ─── Regex helper for order search ───────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── computeEffectiveDeadline ─────────────────────────────────────────────────
// Returns the best available Date for when this thread should be resolved.
// Priority: explicit operator deadline → SLA snapshot → system default → null.
// Pure function — no database calls.

function computeEffectiveDeadline(thread, order) {
  const isLabInteraction = thread.context === 'lab_interaction';

  const explicitDeadline = isLabInteraction
    ? order.deadlines?.lab_response_due
    : order.deadlines?.original_expected;

  if (explicitDeadline) return new Date(explicitDeadline);

  const sentAt = thread.sent_at;
  if (!sentAt) return null;

  const slaDays = isLabInteraction
    ? (thread.sla_layout_days   || LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS)
    : (thread.sla_original_days || LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS);

  return new Date(new Date(sentAt).getTime() + slaDays * MS_PER_DAY);
}

// ─── computeThreadRisk ────────────────────────────────────────────────────────
// Returns 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'.
// Evaluates deadline rules first, then SLA rules, returns MAX of both.
// Pure function — no database calls.

function computeThreadRisk(thread, order) {
  const now = Date.now();

  const timeoutMs    = thread.timeout_at    ? new Date(thread.timeout_at).getTime()    : null;
  const replyMs      = thread.reply_detected_at ? new Date(thread.reply_detected_at).getTime() : null;
  const sentMs       = thread.sent_at       ? new Date(thread.sent_at).getTime()       : null;

  const hoursOverdue   = timeoutMs !== null ? (now - timeoutMs) / MS_PER_HOUR : null;
  const hoursUntil     = timeoutMs !== null ? (timeoutMs - now) / MS_PER_HOUR : null;
  const replyAgeHours  = replyMs   !== null ? (now - replyMs)  / MS_PER_HOUR : null;
  const waitingDays    = sentMs    !== null ? (now - sentMs)   / MS_PER_DAY  : null;

  // ─── Deadline-based rules (first match wins) ──────────────────────────────

  let deadlineRisk = 'LOW';

  if (thread.status === 'unreachable' &&
      thread.error_count >= LAB_COMM_MAX_CONSECUTIVE_ERRORS) {
    deadlineRisk = 'CRITICAL';

  } else if (thread.status === 'timed_out' &&
             hoursOverdue > LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS * 24) {
    deadlineRisk = 'CRITICAL';

  } else if (thread.status === 'replied' &&
             replyAgeHours > LAB_COMM_RISK_CRITICAL_REPLY_HOURS) {
    deadlineRisk = 'CRITICAL';

  } else if (thread.status === 'replied' && thread.reply_has_attachment === true) {
    deadlineRisk = 'HIGH';

  } else if (thread.status === 'timed_out' &&
             hoursOverdue > 24 &&
             hoursOverdue <= LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS * 24) {
    deadlineRisk = 'HIGH';

  } else if (thread.status === 'replied' &&
             replyAgeHours > LAB_COMM_RISK_HIGH_REPLY_HOURS) {
    deadlineRisk = 'HIGH';

  } else if (thread.status === 'waiting' &&
             hoursUntil !== null && hoursUntil > 0 && hoursUntil <= 24) {
    deadlineRisk = 'HIGH';

  } else if (thread.status === 'replied' &&
             replyAgeHours !== null && replyAgeHours <= LAB_COMM_RISK_HIGH_REPLY_HOURS) {
    deadlineRisk = 'MEDIUM';

  } else if (thread.status === 'waiting' &&
             hoursUntil !== null && hoursUntil > 24 && hoursUntil <= 96) {
    deadlineRisk = 'MEDIUM';

  } else if (thread.status === 'timed_out' &&
             hoursOverdue !== null && hoursOverdue <= 24) {
    deadlineRisk = 'MEDIUM';
  }
  // remaining cases → LOW (waiting with 5+ days, waiting with no deadline)

  // ─── SLA-aware rules (lab_interaction + sla_layout_days set + waiting) ────

  let slaRisk = 'LOW';

  if (
    thread.context === 'lab_interaction' &&
    thread.sla_layout_days > 0 &&
    sentMs !== null &&
    thread.status === 'waiting'
  ) {
    const sla = thread.sla_layout_days;
    if (waitingDays > sla * 1.5) {
      slaRisk = 'CRITICAL';
    } else if (waitingDays > sla) {
      slaRisk = 'HIGH';
    } else if (waitingDays >= sla * 0.8) {
      slaRisk = 'MEDIUM';
    }
  }

  return maxRisk(deadlineRisk, slaRisk);
}

// ─── computeOrderRisk ─────────────────────────────────────────────────────────
// Returns the highest risk across all active threads for an order, or null if none.

async function computeOrderRisk(orderId) {
  const threads = await LabCommThread.find({
    order_id: orderId,
    status:   { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] },
  });
  if (threads.length === 0) return null;

  const order = await Order.findById(orderId).lean();
  if (!order) return null;

  return threads.reduce(
    (worst, t) => maxRisk(worst, computeThreadRisk(t, order)),
    'LOW'
  );
}

// ─── computeSlaStatus ─────────────────────────────────────────────────────────
// Returns a human-readable SLA status string for lab_interaction threads.
// Returns null for all other contexts or when SLA data is unavailable.

function computeSlaStatus(thread) {
  if (
    thread.context !== 'lab_interaction' ||
    !thread.sla_layout_days ||
    !thread.sent_at
  ) {
    return null;
  }

  const daysWaiting = Math.floor((Date.now() - new Date(thread.sent_at).getTime()) / MS_PER_DAY);
  const sla         = thread.sla_layout_days;

  if (daysWaiting > sla) {
    return `SLA exceeded (${daysWaiting}d / ${sla}d SLA)`;
  }
  const daysLeft = sla - daysWaiting;
  return `SLA: ${daysLeft}d left (${daysWaiting}d / ${sla}d SLA)`;
}

// ─── TODO: Future Consistency Improvement ─────────────────────────────────────
//
// linkThread currently writes to two collections without atomicity:
//   1. LabCommThread.create()                    — creates the monitoring record
//   2. Order.findOneAndUpdate( gmail_thread_id ) — back-references the thread
//
// A failure between these two writes leaves a monitoring record in
// lab_comm_threads with no corresponding gmail_thread_id on the Order.
// Acceptable at single-operator scale; revisit if volume increases.
//
// Saga-based alternative (no replica set required):
//
//   Step 1: LabCommThread.create({ ..., status: 'linking' })
//           ↳ New ephemeral status — not picked up by poller, visible to operator
//   Step 2: Order.findOneAndUpdate( set gmail_thread_id )
//   Step 3: thread.status = 'waiting' → thread.save()
//
//   Compensation (Step 2 fails):
//   Step 4: thread.status = 'failed_link' → thread.save()
//   Step 5: taskService.createTask(orderId, 'manual',
//             'Thread link failed — retry or investigate', 'high')
//
// Schema prerequisites for saga migration:
//   - Add 'linking' and 'failed_link' to LAB_COMM_STATUSES in LabCommThread.js
//   - Update partialFilterExpression on thread_id and idx_active_version_unique
//     indexes to exclude these two new statuses (currently both use $in over
//     active statuses, so they would automatically exclude new statuses — but
//     verify the poller query in Phase L2 also excludes them)
//   - Add background cleanup for stale 'linking' records (threshold: 60s)
//     in case the Node process crashes between Steps 1 and 3
//
// Full transaction alternative (requires MongoDB replica set):
//   See audit finding C3 — deferred: replica set adds operational complexity
//   not justified at current single-operator deployment scale.
// ─────────────────────────────────────────────────────────────────────────────

// ─── linkThread ───────────────────────────────────────────────────────────────

async function linkThread({ orderId, version, threadId, linkMode, sentAt, context }) {
  // 1. Fetch order
  const order = await Order.findById(orderId);
  if (!order) throw errorUtils.notFoundError('Order not found');

  // 2. Validate version for lab_interaction context
  if (context === 'lab_interaction') {
    if (!order.lab_interactions[version - 1]) {
      throw errorUtils.validationError(
        `lab_interactions version ${version} does not exist on this order`
      );
    }
  }

  // 2b. Guard: reject if an active thread already covers this order+context+version.
  //     The idx_active_version_unique index enforces this at the DB level; this
  //     pre-check returns a meaningful error before the Gmail round-trip.
  const existingVersion = await LabCommThread.findOne({
    order_id: orderId,
    context,
    lab_interaction_version: context === 'lab_interaction' ? version : null,
    status: { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] },
  }).lean();
  if (existingVersion) {
    throw errorUtils.conflictError(
      `An active monitoring thread already exists for ${context}` +
      (context === 'lab_interaction' ? ` version ${version}` : '') +
      '. Close or unlink it before linking a new thread.'
    );
  }

  // 3. Verify thread is accessible via Gmail API and capture message count.
  //    Errors from Gmail (auth, not-found, rate-limit) propagate unchanged.
  const gmailThread = await gmailClient.getThread(threadId, 'metadata');
  const initializedCount = gmailThread.messages?.length || 0;

  // 4. Snapshot lab email — required field; fail early with a clear message
  const recipientEmail = order.laboratory?.laboratoryEmail;
  if (!recipientEmail) {
    throw errorUtils.validationError(
      'Order has no laboratory email configured'
    );
  }

  // 5. Snapshot SLA values from order at link time
  const slaLayoutDays   = order.laboratory?.expectedLayoutDays   || null;
  const slaOriginalDays = order.laboratory?.expectedOriginalDays || null;

  // 6. Build thread document
  const threadData = {
    order_id:                  orderId,
    thread_id:                 threadId,
    context,
    recipient_email:           recipientEmail,
    status:                    'waiting',
    link_mode:                 linkMode,
    linked_at:                 new Date(),
    sent_at:                   sentAt || null,
    sla_layout_days:           slaLayoutDays   || undefined,
    sla_original_days:         slaOriginalDays || undefined,
    initialized_message_count: initializedCount,
    last_known_message_count:  initializedCount,
  };

  if (context === 'lab_interaction') {
    threadData.lab_interaction_version = version;
  }

  // Compute initial timeout_at using the priority cascade
  const timeoutAt = computeEffectiveDeadline(
    { context, sent_at: sentAt, sla_layout_days: slaLayoutDays, sla_original_days: slaOriginalDays },
    order
  );
  if (timeoutAt) threadData.timeout_at = timeoutAt;

  // 7. Create the record — handle partial unique index violation
  let threadDoc;
  try {
    threadDoc = await LabCommThread.create(threadData);
  } catch (err) {
    if (err.code === 11000) {
      if (err.keyPattern?.thread_id) {
        // thread_id partial unique index: same Gmail thread linked to two orders
        const conflict = await LabCommThread.findOne({
          thread_id: threadId,
          status:    { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] },
        }).lean();
        throw errorUtils.threadAlreadyLinkedError(
          `Thread ${threadId} is already actively monitored for another order`,
          conflict ? String(conflict.order_id) : null
        );
      }
      // idx_active_version_unique: concurrent requests both passed the pre-check,
      // second insert lost the DB-level race
      throw errorUtils.conflictError(
        'Concurrent link attempt for the same order/context/version — retry'
      );
    }
    throw err;
  }

  // 8. Update Order's lab_interactions[n].gmail_thread_id (lab_interaction only)
  if (context === 'lab_interaction') {
    await Order.findOneAndUpdate(
      { _id: orderId },
      {
        $set: {
          [`lab_interactions.${version - 1}.gmail_thread_id`]: threadId,
          [`lab_interactions.${version - 1}.gmail_linked_at`]: new Date(),
        },
      }
    );
  }

  // 9. Fire LAB_THREAD_LINKED event
  await eventService.appendEvent(orderId, {
    type:        EVENT_TYPES.LAB_THREAD_LINKED,
    description: `Gmail thread ${threadId} linked (${context}, mode: ${linkMode})`,
    actor:       'operator',
  });

  // 10. Historical threads: create a review task so the operator verifies current state
  if (linkMode === 'historical') {
    await taskService.createTask(
      orderId,
      'manual',
      'Historical thread linked — verify current state and close if already resolved',
      'medium',
      null,
      'auto'
    );
  }

  // 11. Return the created document
  return threadDoc;
}

// ─── unlinkThread ─────────────────────────────────────────────────────────────
// Data correction. Sets status to 'unlinked'. Does NOT fire LAB_THREAD_CLOSED.

async function unlinkThread(threadRecordId, orderId) {
  const thread = await LabCommThread.findById(threadRecordId);
  if (!thread) throw errorUtils.notFoundError('Thread record not found');

  // Ownership check — 404 (not 403) to avoid disclosing existence of the record
  if (String(thread.order_id) !== String(orderId)) {
    throw errorUtils.notFoundError('Thread record not found');
  }

  if (thread.status === 'closed' || thread.status === 'unlinked') {
    throw errorUtils.validationError(
      `Thread is already ${thread.status} and cannot be unlinked`
    );
  }

  thread.status = 'unlinked';
  await thread.save();

  // Clear gmail_thread_id from the Order entry (lab_interaction context only)
  if (thread.context === 'lab_interaction' && thread.lab_interaction_version) {
    const idx = thread.lab_interaction_version - 1;
    await Order.findOneAndUpdate(
      { _id: thread.order_id },
      {
        $unset: {
          [`lab_interactions.${idx}.gmail_thread_id`]: '',
          [`lab_interactions.${idx}.gmail_linked_at`]: '',
        },
      }
    );
  }

  return thread;
}

// ─── closeThread ─────────────────────────────────────────────────────────────
// Normal workflow completion. Fires LAB_THREAD_CLOSED.

async function closeThread(threadRecordId, orderId) {
  const thread = await LabCommThread.findById(threadRecordId);
  if (!thread) throw errorUtils.notFoundError('Thread record not found');

  // Ownership check — 404 (not 403) to avoid disclosing existence of the record
  if (String(thread.order_id) !== String(orderId)) {
    throw errorUtils.notFoundError('Thread record not found');
  }

  if (thread.status === 'closed' || thread.status === 'unlinked') {
    throw errorUtils.validationError(`Thread is already ${thread.status}`);
  }

  thread.status = 'closed';
  await thread.save();

  await eventService.appendEvent(thread.order_id, {
    type:        EVENT_TYPES.LAB_THREAD_CLOSED,
    description: `Lab thread closed for ${thread.context} (thread: ${thread.thread_id})`,
    actor:       'operator',
  });

  return thread;
}

// ─── getThreadsForOrder ───────────────────────────────────────────────────────
// Returns all lab_comm_threads for an order, augmented with risk and slaStatus.
// Returns plain objects (toObject() called internally).

async function getThreadsForOrder(orderId) {
  const threads = await LabCommThread.find({ order_id: orderId }).sort({ created_at: -1 });
  if (threads.length === 0) return [];

  const order = await Order.findById(orderId).lean();

  return threads.map(t => {
    const plain = t.toObject();
    plain.risk      = computeThreadRisk(t, order);
    plain.slaStatus = computeSlaStatus(t);
    return plain;
  });
}

// ─── updateTimeoutAfterDeadlineChange ─────────────────────────────────────────
// Called by orderService after an order deadline is updated.
// Recalculates timeout_at for all active threads of the relevant context.
// If a timed_out thread gets a new future deadline, resets it to 'waiting'.

async function updateTimeoutAfterDeadlineChange(orderId, deadlineField) {
  const FIELD_TO_CONTEXT = {
    lab_response_due:  'lab_interaction',
    original_expected: 'lab_print_order',
  };

  const context = FIELD_TO_CONTEXT[deadlineField];
  if (!context) return 0;

  const order = await Order.findById(orderId).lean();
  if (!order) return 0;

  const threads = await LabCommThread.find({
    order_id: orderId,
    context,
    status:   { $in: ['waiting', 'timed_out'] },
  });

  let updated = 0;
  const now = new Date();

  for (const thread of threads) {
    const newTimeout = computeEffectiveDeadline(thread, order);
    thread.timeout_at = newTimeout || undefined;

    // Operator extended the deadline past now → re-open the thread
    if (thread.status === 'timed_out' && newTimeout && newTimeout > now) {
      thread.status = 'waiting';
    }

    await thread.save();
    updated++;
  }

  return updated;
}

// ─── searchOrders ─────────────────────────────────────────────────────────────
// Multi-field order search. At least one of name/company/phone/email required.

async function searchOrders({ name, company, phone, email, status } = {}) {
  const conditions = [];

  if (name) {
    conditions.push({ 'client.name': { $regex: escapeRegex(name), $options: 'i' } });
  }
  if (company) {
    conditions.push({ 'client.companyName': { $regex: escapeRegex(company), $options: 'i' } });
  }
  if (phone) {
    conditions.push({ 'client.phone': { $regex: '^' + escapeRegex(phone) } });
  }
  if (email) {
    conditions.push({ 'client.email': { $regex: '^' + escapeRegex(email) + '$', $options: 'i' } });
  }
  if (status) {
    conditions.push({ status });
  }

  if (conditions.length === 0) return [];

  return Order.find({ $and: conditions })
    .select(
      'status ' +
      'client.name client.companyName client.phone client.email ' +
      'laboratory.laboratoryName laboratory.laboratoryEmail ' +
      'laboratory.expectedLayoutDays laboratory.expectedOriginalDays ' +
      'created_at'
    )
    .limit(50)
    .lean();
}

// ─── scanUnansweredThreads ────────────────────────────────────────────────────
// Attention scan for unanswered laboratory communication.
//
// Finds linked threads still waiting on a reply whose effective deadline (SLA
// snapshot / operator deadline / system default) has already passed, and raises
// a `remind_lab` attention task for each through the existing task system.
//
// This is a pure database scan — it relies on the persisted thread status
// (the poller flips 'waiting' → 'replied' when a real reply is detected) and
// never calls Gmail. It does NOT mutate thread status; status transitions remain
// the poller's responsibility. Deduplication and order-lifecycle skipping are
// handled by taskService.createTask().
//
// Returns { scanned, overdue, tasksCreated }.

async function scanUnansweredThreads() {
  const now = new Date();

  // Only 'waiting' threads represent linked communication with no genuine reply.
  const threads = await LabCommThread.find({ status: 'waiting' });

  // Cache orders so multiple threads on the same order hit the DB once.
  const orderCache = new Map();
  async function loadOrder(orderId) {
    const key = String(orderId);
    if (orderCache.has(key)) return orderCache.get(key);
    const order = await Order.findById(orderId).lean();
    orderCache.set(key, order);
    return order;
  }

  let overdue      = 0;
  let tasksCreated = 0;

  for (const thread of threads) {
    const order = await loadOrder(thread.order_id);
    if (!order) continue;

    const deadline = computeEffectiveDeadline(thread, order);
    if (!deadline || deadline > now) continue;  // no deadline yet, or still within SLA

    overdue++;

    const task = await taskService.createTask(
      thread.order_id,
      'remind_lab',
      'Lab has not replied — SLA exceeded. Send a reminder.',
      'high',
      deadline,
      'auto'
    );

    // createTask returns null for missing/CANCELLED/COMPLETED orders, or the
    // pre-existing open task when one already covers this order. Count only
    // tasks newly created during this scan (created_at at/after scan start).
    if (task && new Date(task.created_at) >= now) tasksCreated++;
  }

  return { scanned: threads.length, overdue, tasksCreated };
}

// ─── searchGmailThreads ───────────────────────────────────────────────────────
// Searches Gmail and annotates each result with link status.

async function searchGmailThreads(query, maxResults) {
  const rawThreads = await gmailClient.searchThreads(query, maxResults);
  if (rawThreads.length === 0) return [];

  const threadIds = rawThreads.map(t => t.threadId);

  const linked = await LabCommThread.find({
    thread_id: { $in: threadIds },
    status:    { $in: ['waiting', 'replied', 'timed_out', 'unreachable'] },
  }).lean();

  const linkedMap = {};
  for (const rec of linked) {
    linkedMap[rec.thread_id] = String(rec.order_id);
  }

  return rawThreads.map(t => ({
    ...t,
    isAlreadyLinked: !!linkedMap[t.threadId],
    linkedToOrderId: linkedMap[t.threadId] || null,
  }));
}

module.exports = {
  computeEffectiveDeadline,
  computeThreadRisk,
  computeOrderRisk,
  computeSlaStatus,
  linkThread,
  unlinkThread,
  closeThread,
  getThreadsForOrder,
  updateTimeoutAfterDeadlineChange,
  scanUnansweredThreads,
  searchOrders,
  searchGmailThreads,
};
