'use strict';
const config = require('../config');

/** Euclidean distance between two descriptors; Infinity if they are not comparable. */
function faceDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

/** 0–100% confidence for display, same formula as the frontend. */
function faceConfidence(distance) {
  return Math.max(0, Math.min(100, Math.round((1 - distance / 1.0) * 100)));
}

const isMatch = (distance) => distance <= config.faceMatchThreshold;

function parseDescriptor(raw) {
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}

module.exports = { faceDistance, faceConfidence, isMatch, parseDescriptor };
