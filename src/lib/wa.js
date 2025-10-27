import axios from 'axios';

const WA_BASE = 'https://graph.facebook.com/v21.0';

export function inWindow(now, windowStr = '') {
  if (!windowStr) return true;
  const [start, end] = windowStr.split('-');
  if (!start || !end) return true;
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const minutes = now.getHours() * 60 + now.getMinutes();
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (e >= s) return minutes >= s && minutes <= e;
  return minutes >= s || minutes <= e; // cruza medianoche
}

export async function sendTemplate({
  phone_id,
  token,
  to,
  template_name,
  language = 'es',
  components = []
}) {
  const url = `${WA_BASE}/${phone_id}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template_name,
      language: { code: language },
      components
    }
  };
  const res = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data; // { messages: [{ id: 'wamid...' }] }
}
