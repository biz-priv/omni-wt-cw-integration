'use strict'

const momentTZ = require('moment-timezone');

const cstDateTime = momentTZ.tz('America/Chicago').format('YYYY/MM/DD HH:mm:ss').toString();

const STATUSES = {
  PENDING: 'PENDING',
  READY: 'READY',
  SENT: 'SENT',
  FAILED: 'FAILED',
};

module.exports = {
  cstDateTime,
  STATUSES
}
