'use strict';

// models/KbVideo.js — one source video in the Certification Knowledge Base.
//
// This is the video INVENTORY produced by enumerating the Dokumenty.pro YouTube
// channel. It is research/replica data — it never drives a client response on its
// own. Knowledge extracted from a video lives in KbEntry records, each of which must
// pass operator review before it can be used. See services/knowledgeBaseService.js.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const TRANSCRIPT_STATUSES = ['available', 'missing', 'unsupported'];

const kbVideoSchema = new Schema({
  channel:    { type: String, trim: true },         // e.g. '@dokumenty_pro'
  video_id:   { type: String, required: true, trim: true },
  title:      { type: String, trim: true },
  url:        { type: String, trim: true },
  published_at: { type: Date },
  duration:   { type: String, trim: true },
  description: { type: String },

  transcript_status: { type: String, enum: TRANSCRIPT_STATUSES, default: 'missing' },
  language:   { type: String, trim: true },

  // Generated structured summary (review artifact — not client-facing).
  summary:    { type: String },
  confidence: { type: String },                     // aggregate extraction confidence
  // Operator-confirmation questions raised for this video (review artifact).
  questions:  { type: [String], default: [] },

  entry_count:            { type: Number, default: 0 },
  possibly_outdated_count: { type: Number, default: 0 },

  extracted_at: { type: Date },
  created_at:   { type: Date, default: Date.now },
}, {
  collection: 'kb_videos',
  versionKey: false,
});

kbVideoSchema.index({ video_id: 1 }, { unique: true });
kbVideoSchema.index({ published_at: -1 });

const KbVideo = mongoose.model('KbVideo', kbVideoSchema);

module.exports = { KbVideo, TRANSCRIPT_STATUSES };
