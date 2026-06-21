'use strict';

// ─── Order lifecycle ──────────────────────────────────────────────────────────

// The canonical order statuses ARE the six Google Sheet "Declaration" statuses —
// the system stores the Russian business label directly in Order.status, with no
// internal code layer. Order.status is therefore identical to the sheet value.
//
//   Запустить        payment received; client/declaration data being entered and
//                    the order prepared; laboratory request not yet sent
//   Ждем макет        laboratory request sent; awaiting the layout (макет)
//   На согласовании   layout received; with the client for approval
//   Ждем оригинал     layout approved, or corrections sent to the lab; awaiting
//                    the final declaration/certificate
//   Оригинал получен  original received from the lab; not yet handed to the client
//   Завершен          original delivered to the client (terminal, success)
//   Отменен           order cancelled (terminal) — e.g. client cancelled, documents
//                    not provided, laboratory rejection, duplicate order. The
//                    reason is recorded in Order.cancelled_reason.
//
// An order starts at "Запустить" (there is no pre-payment status). "Отменен" is a
// real Declaration status, reachable from any active status, and is terminal.
const ORDER_STATUSES = [
  'Запустить',
  'Ждем макет',
  'На согласовании',
  'Ждем оригинал',
  'Оригинал получен',
  'Завершен',
  'Отменен',
];

// ─── Task ─────────────────────────────────────────────────────────────────────

const TASK_TYPES = [
  'remind_lab',
  'follow_up_client',
  'send_layout',
  'send_original',
  'check_payment',
  'stale_intake',
  'manual',
];

const TASK_PRIORITIES = ['high', 'medium', 'low'];

// ─── Attention engine thresholds ─────────────────────────────────────────────

const STALE_NEW_ORDER_DAYS    = 3;
const LAYOUT_NOT_SENT_HOURS   = 24;
const ORIGINAL_NOT_SENT_HOURS = 48;

// ─── Event type codes ─────────────────────────────────────────────────────────
// Source of truth for all event type strings. See docs/WORKFLOW_EVENTS.md.

const EVENT_TYPES = {
  // Order lifecycle
  ORDER_CREATED:                'ORDER_CREATED',
  ORDER_STATUS_CHANGED:         'ORDER_STATUS_CHANGED',
  ORDER_CANCELLED:              'ORDER_CANCELLED',
  ORDER_COMPLETED:              'ORDER_COMPLETED',
  ORDER_DEADLINE_SET:           'ORDER_DEADLINE_SET',

  // Payments
  PAYMENT_RECORDED:             'PAYMENT_RECORDED',
  PAYMENT_VOIDED:               'PAYMENT_VOIDED',
  BALANCE_UPDATED:              'BALANCE_UPDATED',
  BALANCE_CLEARED:              'BALANCE_CLEARED',

  // Lab workflow
  LAB_REQUEST_SENT:             'LAB_REQUEST_SENT',
  LAB_REMINDER_SENT:            'LAB_REMINDER_SENT',
  LAB_LAYOUT_RECEIVED:          'LAB_LAYOUT_RECEIVED',
  LAB_ORIGINAL_RECEIVED:        'LAB_ORIGINAL_RECEIVED',

  // Client workflow
  CLIENT_LAYOUT_SENT:           'CLIENT_LAYOUT_SENT',
  CLIENT_LAYOUT_APPROVED:       'CLIENT_LAYOUT_APPROVED',
  CLIENT_CORRECTIONS_REQUESTED: 'CLIENT_CORRECTIONS_REQUESTED',
  CLIENT_ORIGINAL_SENT:         'CLIENT_ORIGINAL_SENT',

  // Tasks
  TASK_CREATED:                 'TASK_CREATED',
  TASK_COMPLETED:               'TASK_COMPLETED',
  TASK_DISMISSED:               'TASK_DISMISSED',
  TASK_UNSNOOZED:               'TASK_UNSNOOZED',

  // Lab communication threads — Phase L1 (fired in L1)
  LAB_THREAD_LINKED:            'LAB_THREAD_LINKED',
  LAB_THREAD_CLOSED:            'LAB_THREAD_CLOSED',

  // Lab communication threads — Phase L2+ (defined here, fired later)
  LAB_THREAD_REPLY_DETECTED:        'LAB_THREAD_REPLY_DETECTED',
  LAB_THREAD_ATTACHMENT_DETECTED:   'LAB_THREAD_ATTACHMENT_DETECTED',
  LAB_THREAD_TIMED_OUT:             'LAB_THREAD_TIMED_OUT',

  // Workflow event detection from lab emails (recommendation lifecycle)
  WORKFLOW_EVENT_DETECTED:          'WORKFLOW_EVENT_DETECTED',
  WORKFLOW_EVENT_CONFIRMED:         'WORKFLOW_EVENT_CONFIRMED',
  WORKFLOW_EVENT_REJECTED:          'WORKFLOW_EVENT_REJECTED',
};

// ─── Lab communication — Phase L1 ────────────────────────────────────────────

// LAB_COMM_POLL_CRON defined here, first used in Phase L2
const LAB_COMM_POLL_CRON = process.env.LAB_COMM_POLL_CRON || '*/30 * * * *';

const LAB_COMM_MAX_CONSECUTIVE_ERRORS = 3;
const LAB_COMM_BATCH_DELAY_MS         = 200;

const LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS =
  parseInt(process.env.LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS, 10) || 5;
const LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS =
  parseInt(process.env.LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS, 10) || 10;

const LAB_COMM_RISK_HIGH_REPLY_HOURS      = 12;
const LAB_COMM_RISK_CRITICAL_REPLY_HOURS  = 48;
const LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS = 3;

const LAB_COMM_SEARCH_MAX_RESULTS = 50;

const LAB_COMM_ATTACHMENT_MIMETYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
];

const LAB_COMM_AUTO_REPLY_SUBJECTS = [
  'Auto:',
  'Automatic reply:',
  'Out of office:',
];

// ─── Workflow event detection from lab emails ─────────────────────────────────
//
// The Gmail Agent inspects the latest message of a linked lab thread and, when
// the sender is a known laboratory, classifies it into a workflow event. Matching
// is case-insensitive substring ("contains"); all matched terms are recorded as
// evidence on the WorkflowDetection record. Detection only ever PROPOSES — the
// status transition and the Google Sheet write happen solely after an operator
// confirms the recommendation. There is no automatic completion.

const LAB_KNOWN_SENDERS = [
  'standartpro98@gmail.com',
  'mng-1@kyrgyz-test.kg',
  'test@test.kg',
];

// LAYOUT_RECEIVED — laboratory sent a layout ("макет") for client approval
const LAYOUT_BODY_KEYWORDS     = ['макет', 'согласуйте макет', 'макет во вложении'];
const LAYOUT_FILENAME_KEYWORDS = ['макет', 'layout', 'draft'];

// ORIGINAL_RECEIVED — laboratory sent the final declaration/certificate
const ORIGINAL_BODY_KEYWORDS     = ['ДС во вложении', 'СС во вложении'];
const ORIGINAL_FILENAME_KEYWORDS = ['ДС', 'СС', 'декларация', 'сертификат'];

// Detected lab-email event → recommended status transition, expressed directly in
// the six business statuses. `from` is the SET of statuses from which the
// recommendation is auto-applicable on confirm; in any other status the detection
// is flagged needs_review. No mapping targets "Завершен" — completion is
// operator-driven only (original physically delivered to the client). There is no
// separate sheet-label map: Order.status already IS the sheet value.
//
// Corrections are deliberately NOT a single hardcoded path — the business supports
// both outcomes, distinguished by what the lab actually sends back:
//   • Lab applies corrections and issues the final document directly
//       → operator-driven move to "Ждем оригинал" (no lab email to detect)
//   • Lab returns a revised layout for another approval round
//       → LAB_LAYOUT_RECEIVED fires again, recommending the order BACK to
//         "На согласовании"
// That second case is why LAYOUT_RECEIVED is recommendable from "Ждем оригинал"
// as well as from the initial "Ждем макет" state.
const WORKFLOW_STATUS_MAP = {
  LAYOUT_RECEIVED:   { from: ['Ждем макет', 'Ждем оригинал'], to: 'На согласовании',   orderEvent: 'LAB_LAYOUT_RECEIVED'   },
  ORIGINAL_RECEIVED: { from: ['Ждем оригинал'],               to: 'Оригинал получен',  orderEvent: 'LAB_ORIGINAL_RECEIVED' },
};

// ─── Google Sheets write-back ─────────────────────────────────────────────────
// The Declaration sheet column that holds the workflow status. Default 'G' follows
// the documented column order (payment_date A … notes F, status G); override with
// DECLARATION_STATUS_COLUMN if the sheet differs.
const DECLARATION_SHEET_STATUS_COLUMN = process.env.DECLARATION_STATUS_COLUMN || 'G';

// The Declaration sheet column layout, in order A → G (status column is the last and
// must line up with DECLARATION_SHEET_STATUS_COLUMN). Used when APPENDING a new
// declaration row during Approved Draft Execution. Each entry names the Declaration
// field whose value goes in that column.
const DECLARATION_SHEET_COLUMNS = [
  'payment_date',   // A
  'payment_amount', // B
  'client_name',    // C
  'document_type',  // D
  'phone',          // E
  'notes',          // F
  'status',         // G
];

module.exports = {
  DECLARATION_SHEET_STATUS_COLUMN,
  DECLARATION_SHEET_COLUMNS,
  ORDER_STATUSES,
  TASK_TYPES,
  TASK_PRIORITIES,
  STALE_NEW_ORDER_DAYS,
  LAYOUT_NOT_SENT_HOURS,
  ORIGINAL_NOT_SENT_HOURS,
  EVENT_TYPES,
  LAB_COMM_POLL_CRON,
  LAB_COMM_MAX_CONSECUTIVE_ERRORS,
  LAB_COMM_BATCH_DELAY_MS,
  LAB_COMM_DEFAULT_LAYOUT_SLA_DAYS,
  LAB_COMM_DEFAULT_ORIGINAL_SLA_DAYS,
  LAB_COMM_RISK_HIGH_REPLY_HOURS,
  LAB_COMM_RISK_CRITICAL_REPLY_HOURS,
  LAB_COMM_RISK_CRITICAL_OVERDUE_DAYS,
  LAB_COMM_SEARCH_MAX_RESULTS,
  LAB_COMM_ATTACHMENT_MIMETYPES,
  LAB_COMM_AUTO_REPLY_SUBJECTS,
  LAB_KNOWN_SENDERS,
  LAYOUT_BODY_KEYWORDS,
  LAYOUT_FILENAME_KEYWORDS,
  ORIGINAL_BODY_KEYWORDS,
  ORIGINAL_FILENAME_KEYWORDS,
  WORKFLOW_STATUS_MAP,
};
