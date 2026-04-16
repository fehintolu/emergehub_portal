function formatNgn(cents) {
  const n = Number(cents) || 0;
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n / 100);
}

function formatDate(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = { formatNgn, formatDate, formatDateTime };
