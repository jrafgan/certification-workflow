'use strict';

// models/NewApplicationProposal.js — предложение оператору по НОВОЙ заявке (Новая форма).
//
// Когда клиент заполняет Новую форму, агент классифицирует (ДС/СС), считает протоколы (ПИ)
// и ориентировочную сумму и ГОТОВИТ черновик ответа клиенту. Это OUTPUT-ONLY предложение:
// ничего не отправляется и не пишется в Декларацию — оператор подтверждает/правит/отклоняет
// (recommendation mode). Источник истины по заявкам — сам лист Новой формы; это рабочая копия.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = ['pending', 'approved', 'dismissed'];

const warningSchema = new Schema({
  code:    { type: String, trim: true },
  message: { type: String, trim: true },
}, { _id: false });

const newApplicationProposalSchema = new Schema({
  // Кто и по какому телефону (для матчинга с WhatsApp/Декларацией — phone_key = последние 9 цифр)
  applicant_name:  { type: String, trim: true },
  applicant_phone: { type: String, trim: true },
  phone_key:       { type: String, trim: true },

  // Классификация (может быть неполной → needs[])
  doc_type:  { type: String, enum: ['ДС', 'СС', null], default: null }, // null → оператор определяет тип
  category:  { type: String, trim: true },  // knitwear | sewing | mixed | unknown
  age:       { type: String, trim: true },  // child | adult | unknown

  // Расчёт (когда doc_type определён)
  protocol_count:  { type: Number, min: 0 }, // ПИ = число протокольных групп
  additional_pi:   { type: Number, min: 0 },
  total_estimate:  { type: Number, min: 0 },
  currency:        { type: String, trim: true },
  is_minimum:      { type: Boolean, default: true }, // сумма «от …»
  samples_required: { type: Number, min: 0 },
  laboratory:      { type: String, trim: true },

  // Готовый черновик ответа клиенту (оператор отправляет ПОСЛЕ подтверждения; агент не шлёт)
  draft_reply: { type: String },

  warnings: { type: [warningSchema], default: [] },
  needs:    { type: [String], default: [] },   // что должен доуточнить оператор
  evidence: { type: [String], default: [] },   // основания расчёта (basis)

  source: {
    sheet_tab: { type: String, trim: true },
    row_index: { type: Number },
    applicant: { type: String, trim: true },
    phone:     { type: String, trim: true },
  },

  dedupe_key: { type: String, required: true }, // контентный ключ строки → идемпотентность
  status:     { type: String, enum: STATUSES, default: 'pending' },
  decided_by: { type: Schema.Types.ObjectId, ref: 'User' },
  decided_at: { type: Date },
}, {
  collection: 'new_application_proposals',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
});

newApplicationProposalSchema.index({ dedupe_key: 1 }, { unique: true });
newApplicationProposalSchema.index({ status: 1, created_at: -1 });
newApplicationProposalSchema.index({ phone_key: 1 });

const NewApplicationProposal = mongoose.model('NewApplicationProposal', newApplicationProposalSchema);

module.exports = { NewApplicationProposal, NEW_APPLICATION_PROPOSAL_STATUSES: STATUSES };
