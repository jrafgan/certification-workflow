'use strict';

// services/workflowDetectionService.js — Gmail Agent workflow event detection
//
// Inspects a lab email, classifies it into a workflow event (layout/original
// received), and creates a WorkflowDetection PROPOSAL. Detection never changes
// order state or the sheet on its own — an operator confirms the recommendation
// first (confirmDetection), which then applies the status transition and queues
// the Google Sheet status update.
//
// The classification and recommendation decision are pure functions (exported for
// testing); persistence and side effects live in detect/confirm/reject.

const { WorkflowDetection } = require('../models/WorkflowDetection');
const { Order }             = require('../models/Order');
const gmailClient           = require('../integrations/gmailClient');
const eventService          = require('./eventService');
const declarationService    = require('./declarationService');
const errorUtils            = require('../utils/errorUtils');
const {
  LAB_KNOWN_SENDERS,
  LAYOUT_BODY_KEYWORDS,
  LAYOUT_FILENAME_KEYWORDS,
  ORIGINAL_BODY_KEYWORDS,
  ORIGINAL_FILENAME_KEYWORDS,
  WORKFLOW_STATUS_MAP,
  EVENT_TYPES,
} = require('../config/constants');

const EMAIL_EXCERPT_MAX = 500;

// Deterministic order of events — also the precedence used to pick the nominal
// detected_event of a conflict (an email matching both cues records LAYOUT_RECEIVED
// as its event but carries both rule sets as evidence and recommendation 'conflict').
const EVENT_RULES = [
  {
    event:        'LAYOUT_RECEIVED',
    bodyKeywords:     LAYOUT_BODY_KEYWORDS,
    filenameKeywords: LAYOUT_FILENAME_KEYWORDS,
  },
  {
    event:        'ORIGINAL_RECEIVED',
    bodyKeywords:     ORIGINAL_BODY_KEYWORDS,
    filenameKeywords: ORIGINAL_FILENAME_KEYWORDS,
  },
];

// ─── Pure: sender gate ──────────────────────────────────────────────────────────

// Extracts a bare email address from a "From" header value and tests it against
// the known-laboratory allowlist (case-insensitive).
function isKnownLabSender(fromHeader) {
  if (!fromHeader) return false;
  const angle = fromHeader.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  return LAB_KNOWN_SENDERS.some(s => s.trim().toLowerCase() === email);
}

// ─── Pure: classification ───────────────────────────────────────────────────────

function _matchKeywords(haystack, keywords, source) {
  const lc = (haystack || '').toLowerCase();
  const hits = [];
  for (const kw of keywords) {
    if (lc.includes(kw.toLowerCase())) hits.push({ source, term: kw });
  }
  return hits;
}

// Classifies a message body + attachment filenames into matched workflow events.
// Returns { matchedByEvent: { EVENT: [ {source, term}, ... ] } } — only events
// with at least one matched rule are present. Substring match, case-insensitive.
function classifyMessage({ body = '', filenames = [] } = {}) {
  const matchedByEvent = {};
  for (const rule of EVENT_RULES) {
    const matches = [
      ..._matchKeywords(body, rule.bodyKeywords, 'body'),
    ];
    for (const fn of filenames) {
      matches.push(..._matchKeywords(fn, rule.filenameKeywords, 'attachment'));
    }
    if (matches.length > 0) matchedByEvent[rule.event] = matches;
  }
  return { matchedByEvent };
}

// ─── Pure: recommendation decision ──────────────────────────────────────────────

// Given a single detected event and the order's current status, decides whether
// the recommendation is auto-applicable on confirm.
//   transition    → order is in an expected `from` status; recommended_to is set
//   needs_review  → order is in some other status; recommended_to is null
function decideRecommendation(detectedEvent, orderStatus) {
  const map = WORKFLOW_STATUS_MAP[detectedEvent];
  if (map && map.from.includes(orderStatus)) {
    return { recommendation: 'transition', recommended_to: map.to };
  }
  return { recommendation: 'needs_review', recommended_to: null };
}

// ─── Persistence: create a detection from a Gmail message ───────────────────────

// Inspects one Gmail message (fetched with format 'full') belonging to a linked
// lab thread and, when it classifies into a workflow event, creates a pending
// WorkflowDetection. Idempotent on (thread_id, message_id, detected_event).
// Returns { detected, skipped, reason, detection }.
async function detectFromMessage(orderId, threadId, message) {
  const headers   = message?.payload?.headers || [];
  const fromHdr   = gmailClient.extractHeader(headers, 'from');

  if (!isKnownLabSender(fromHdr)) {
    return { detected: false, skipped: true, reason: 'sender_not_known_lab' };
  }

  const order = await Order.findById(orderId).select('status').lean();
  if (!order) return { detected: false, skipped: true, reason: 'order_not_found' };

  const body      = gmailClient.getMessageBody(message);
  const filenames = gmailClient.getAttachmentFilenames(message);
  const { matchedByEvent } = classifyMessage({ body, filenames });

  const events = EVENT_RULES.map(r => r.event).filter(e => matchedByEvent[e]);
  if (events.length === 0) return { detected: false, reason: 'no_match' };

  const isConflict    = events.length > 1;
  const detectedEvent = events[0]; // EVENT_RULES order = deterministic precedence
  const matchedRules  = isConflict
    ? events.flatMap(e => matchedByEvent[e])
    : matchedByEvent[detectedEvent];

  let recommendation = 'conflict';
  let recommendedTo  = null;
  if (!isConflict) {
    ({ recommendation, recommended_to: recommendedTo } =
      decideRecommendation(detectedEvent, order.status));
  }

  const subject = gmailClient.extractHeader(headers, 'subject') || undefined;
  const doc = {
    order_id:             orderId,
    thread_id:            threadId,
    message_id:           message.id,
    detected_event:       detectedEvent,
    matched_rules:        matchedRules,
    email_from:           fromHdr || undefined,
    email_subject:        subject,
    email_excerpt:        (body || '').slice(0, EMAIL_EXCERPT_MAX),
    attachment_filenames: filenames,
    recommended_from:     order.status,
    recommended_to:       recommendedTo,
    recommendation,
    status:               'pending',
  };

  let detection;
  try {
    detection = await WorkflowDetection.create(doc);
  } catch (err) {
    // Idempotency: the same email cannot raise the same event twice
    if (err && (err.code === 11000 || err.code === 'E11000')) {
      const existing = await WorkflowDetection.findOne({
        thread_id: threadId, message_id: message.id, detected_event: detectedEvent,
      });
      return { detected: false, skipped: true, reason: 'duplicate', detection: existing };
    }
    throw err;
  }

  await eventService.appendEvent(orderId, {
    type:        EVENT_TYPES.WORKFLOW_EVENT_DETECTED,
    description: `Detected ${detectedEvent} from lab email (recommendation: ${recommendation})`,
    actor:       'system',
  });

  return { detected: true, detection };
}

// ─── Confirmation handlers ──────────────────────────────────────────────────────

// Operator confirms a pending 'transition' recommendation. Applies the status
// transition, records the order events, and queues the Google Sheet status update.
// Only 'transition' recommendations are confirmable — 'needs_review' / 'conflict'
// have no recommended_to and require manual handling.
async function confirmDetection(detectionId, decidedBy = 'operator') {
  const detection = await WorkflowDetection.findById(detectionId);
  if (!detection) throw errorUtils.notFoundError('Detection not found');
  if (detection.status !== 'pending') {
    throw errorUtils.conflictError(`Detection already ${detection.status}`);
  }
  if (detection.recommendation !== 'transition' || !detection.recommended_to) {
    throw errorUtils.validationError(
      `Detection is "${detection.recommendation}" and cannot be auto-applied; resolve manually`
    );
  }

  const order = await Order.findById(detection.order_id);
  if (!order) throw errorUtils.notFoundError('Order not found');

  const map = WORKFLOW_STATUS_MAP[detection.detected_event];
  // Status may have drifted since the detection was raised — re-check the precondition.
  if (!map.from.includes(order.status)) {
    detection.status     = 'superseded';
    detection.decided_at = new Date();
    detection.decided_by = decidedBy;
    await detection.save();
    throw errorUtils.conflictError(
      `Order status "${order.status}" no longer matches detection precondition; marked superseded`
    );
  }

  const fromStatus = order.status;
  const toStatus   = detection.recommended_to;
  const now        = new Date();

  order.status = toStatus;
  order.events.push(
    { type: map.orderEvent,                 description: `${detection.detected_event} confirmed from lab email`, actor: 'operator', timestamp: now },
    { type: EVENT_TYPES.ORDER_STATUS_CHANGED, description: `${fromStatus} → ${toStatus}`,                          actor: 'operator', timestamp: now },
    { type: EVENT_TYPES.WORKFLOW_EVENT_CONFIRMED, description: `Detection ${detection._id} confirmed`,             actor: 'operator', timestamp: now },
  );
  await order.save();

  // Google Sheet status update — Order.status IS the sheet value. Mirror it onto
  // the linked Declaration (status + pending), then write it back to the sheet.
  const declaration = await declarationService.updateStatusFromOrder(order._id, toStatus);

  let sheetWrite = null;
  if (declaration) {
    // Write-back must not roll back a confirmed transition. On failure the
    // declaration is left non-synced and retryPendingDeclarations picks it up.
    const sheetsSync = require('../integrations/sheetsSync');
    try {
      sheetWrite = await sheetsSync.writeDeclarationRow(declaration._id);
    } catch (err) {
      sheetWrite = { written: false, error: err.message || String(err) };
    }
  }

  detection.status     = 'confirmed';
  detection.decided_at = now;
  detection.decided_by = decidedBy;
  await detection.save();

  return { detection, order, fromStatus, toStatus, sheetUpdated: !!declaration, sheetWrite };
}

// Operator rejects a pending detection. No status or sheet change.
async function rejectDetection(detectionId, decidedBy = 'operator') {
  const detection = await WorkflowDetection.findById(detectionId);
  if (!detection) throw errorUtils.notFoundError('Detection not found');
  if (detection.status !== 'pending') {
    throw errorUtils.conflictError(`Detection already ${detection.status}`);
  }

  detection.status     = 'rejected';
  detection.decided_at = new Date();
  detection.decided_by = decidedBy;
  await detection.save();

  await eventService.appendEvent(detection.order_id, {
    type:        EVENT_TYPES.WORKFLOW_EVENT_REJECTED,
    description: `Detection ${detection._id} (${detection.detected_event}) rejected`,
    actor:       'operator',
  });

  return { detection };
}

// ─── Read: pending recommendations for operator review ──────────────────────────

// Lists pending detections newest-first with everything the operator needs to see:
// sender, subject, last message text, attachment names, and the recommendation.
async function listPending(limit = 50) {
  const docs = await WorkflowDetection
    .find({ status: 'pending' })
    .sort({ detected_at: -1 })
    .limit(limit)
    .lean();

  return docs.map(d => ({
    id:              d._id,
    order_id:        d.order_id,
    detected_event:  d.detected_event,
    recommendation:  d.recommendation,
    recommended_from: d.recommended_from,
    recommended_to:  d.recommended_to,
    sender:          d.email_from || '',
    subject:         d.email_subject || '',
    last_message:    d.email_excerpt || '',
    attachments:     d.attachment_filenames || [],
    detected_at:     d.detected_at,
  }));
}

module.exports = {
  // pure
  isKnownLabSender,
  classifyMessage,
  decideRecommendation,
  // persistence / side effects
  detectFromMessage,
  confirmDetection,
  rejectDetection,
  // read
  listPending,
};
