// Shared, side-effect-free request scheduling and passive-preview decisions.
// Public page metadata is always preferred to launching a browser.
export function passiveBrowserNeeded({ challenge = false, verification = false, approvedSession = false, restrictedStatus = false, httpOk = false, hasImage = false } = {}) {
  if (hasImage) return false;
  if (challenge) return Boolean(approvedSession);
  if (verification && !approvedSession) return false;
  return Boolean(restrictedStatus || httpOk);
}

export function outboundRequestSpacingMs(pressure = 'normal') {
  if (pressure === 'throttled') return 550;
  if (pressure === 'elevated') return 300;
  return 180;
}
