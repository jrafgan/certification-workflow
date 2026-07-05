'use strict';

// models/ApplicationOverride.js — operator's manual verdict on a New-Form application.
//
// Why this exists: the agent's «новая заявка / уже ответили» guess is imperfect (it can't see
// replies made outside the system, offline deals, duplicates…). This lets the OPERATOR record
// the truth — «уже ответили» / «не актуальна» / … — and the inbox then trusts the human over the
// agent's guess. Reversible: reopening deletes the doc (the app can become «new» again).
//
// Keyed by app_key = the canonical phone match key when available, else `row:<sheetRow>` (some
// applications carry a phone we can't match; the form row still identifies them). One doc per app.

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Reasons an application is NOT a new/actionable lead. Extend as operators surface more cases.
const APPLICATION_OVERRIDE_REASONS = [
  'already_replied',   // уже ответили клиенту (вне системы или до того, как агент увидел)
  'not_relevant',      // не актуальна — клиент передумал / потерян
  'duplicate',         // дубликат заявки того же клиента
  'spam_wrong',        // спам / ошибочная заявка / не тот номер
  'handled_offline',   // обработана вне системы (звонок / лично / другой канал)
  'already_client',    // уже действующий клиент / есть заказ
  'other',             // другое (см. note)
];
const APPLICATION_OVERRIDE_STATUSES = ['not_new'];   // room to grow (e.g. 'priority') later

const applicationOverrideSchema = new Schema({
  app_key:     { type: String, trim: true, required: true, unique: true }, // phone_key | `row:<n>`
  status:      { type: String, enum: APPLICATION_OVERRIDE_STATUSES, default: 'not_new' },
  reason:      { type: String, enum: APPLICATION_OVERRIDE_REASONS, required: true },
  note:        { type: String, trim: true },

  // Provenance for the operator/audit view.
  phone_key:   { type: String, trim: true },
  sheet_row:   { type: Number },
  client_name: { type: String, trim: true },

  set_by:      { type: String, trim: true, default: 'operator' },
}, {
  collection: 'application_overrides',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});

const ApplicationOverride = mongoose.models.ApplicationOverride
  || mongoose.model('ApplicationOverride', applicationOverrideSchema);

module.exports = { ApplicationOverride, APPLICATION_OVERRIDE_REASONS, APPLICATION_OVERRIDE_STATUSES };
