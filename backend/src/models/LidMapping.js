'use strict';

// models/LidMapping.js — persisted WhatsApp LID → phone resolution.
//
// WhatsApp addresses some contacts by a "LID" ("<digits>@lid") instead of a phone
// number. whatsapp-web.js can sometimes resolve the real phone (getContactLidAndPhone),
// but resolution is best-effort and may be unavailable on a later message. We persist
// each successful resolution so a known LID keeps matching even when a live resolve
// returns nothing. This is REPLICA/working data — it never drives a Declaration write.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const lidMappingSchema = new Schema({
  lid:       { type: String, required: true, trim: true }, // serialized wid, e.g. "37087478829063@lid"
  lid_key:   { type: String, trim: true },                 // user part, e.g. "37087478829063"

  phone:     { type: String, trim: true },                 // resolved phone digits, e.g. "996700112233"
  phone_key: { type: String, trim: true },                 // canonical match key (last 9 local digits)

  source:      { type: String, trim: true, default: 'getContactLidAndPhone' },
  resolved_at: { type: Date,   default: Date.now },         // resolution timestamp (requirement #2)
  last_seen_at: { type: Date },
}, {
  collection: 'lid_mappings',
  versionKey: false,
});

// One mapping per LID; look up by phone key for reverse association.
lidMappingSchema.index({ lid: 1 }, { unique: true });
lidMappingSchema.index({ phone_key: 1 });

const LidMapping = mongoose.model('LidMapping', lidMappingSchema);

module.exports = { LidMapping };
