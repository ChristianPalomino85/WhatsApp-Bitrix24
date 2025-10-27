export function normalizePhone(raw, { defaultCountryCode = '' } = {}) {
  if (raw === null || raw === undefined) return '';
  const cc = String(defaultCountryCode || '').replace(/\D/g, '');
  let digits = String(raw).trim();
  digits = digits.replace(/[^0-9]/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0') && cc) {
    digits = `${cc}${digits.slice(1)}`;
  }

  if (cc && !digits.startsWith(cc) && digits.length <= 10) {
    digits = `${cc}${digits}`;
  }

  digits = digits.replace(/^0+/, '');
  return digits;
}

export function isLikelyValidPhone(phone) {
  return /^\d{7,15}$/.test(phone);
}

