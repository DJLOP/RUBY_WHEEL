/**
 * The one error type the canonical-geography store throws on purpose.
 *
 * `status` is the HTTP status the router answers with. The optional detail lists are
 * returned alongside the message so a caller sees every problem at once — an accept that
 * fails for three reasons says all three, rather than one per attempt.
 */
class CanonicalError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'CanonicalError';
    this.status = status;
    this.details = details;
  }
}

const invalid = (message, details) => new CanonicalError(400, message, details);
const notFound = (message) => new CanonicalError(404, message);
const conflict = (message, details) => new CanonicalError(409, message, details);

module.exports = { CanonicalError, invalid, notFound, conflict };
