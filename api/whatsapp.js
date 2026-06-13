/**
 * Vercel Serverless Function · /api/whatsapp
 * ------------------------------------------------------------------
 * Sends ONLY the WhatsApp template. (The lead goes to LeadPlus directly
 * from the browser, exactly like the working version.)
 *
 *  POST { name, phone }      -> sends the template to that customer
 *  GET                       -> health check (which env vars are set)
 *  GET ?selftest=<10-digit>  -> sends a test WhatsApp, returns raw response
 *
 * Env vars (Vercel → Settings → Environment Variables):
 *   WABA_API_KEY, WABA_USER_ID, WABA_NUMBER, WABA_TEMPLATE_NAME
 *   Optional (image-header templates): WABA_MEDIA_URL or WABA_MEDIA_ID
 * ------------------------------------------------------------------
 */

const WABA_URL = 'https://Waba.atsocialapi.com/WAApi/send';
const https    = require('https');

module.exports = async (req, res) => {

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const selftest = url.searchParams.get('selftest');
    if (selftest) {
      const phone = String(selftest).replace(/\D/g, '');
      if (phone.length !== 10) {
        res.status(400).json({ ok: false, error: 'selftest needs a 10-digit phone, e.g. ?selftest=9512516886' });
        return;
      }
      const r = await sendTemplate('Test', phone);
      res.status(200).json(r);
      return;
    }
    res.status(200).json({
      ok: true,
      service: 'y2b-whatsapp',
      node: process.version,
      env: {
        WABA_API_KEY:       !!process.env.WABA_API_KEY,
        WABA_USER_ID:       !!process.env.WABA_USER_ID,
        WABA_NUMBER:        !!process.env.WABA_NUMBER,
        WABA_TEMPLATE_NAME: !!process.env.WABA_TEMPLATE_NAME
      }
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJson(req);
    const phone = String(body.phone || '').replace(/\D/g, '');
    if (phone.length !== 10) {
      res.status(400).json({ ok: false, error: 'Invalid phone' });
      return;
    }
    const result = await sendTemplate(body.name || 'there', phone);
    res.status(200).json(result);
  } catch (err) {
    console.error('whatsapp handler error:', err);
    res.status(500).json({ ok: false, error: 'Server error', detail: String(err) });
  }
};

async function sendTemplate(name, phone) {
  if (!process.env.WABA_API_KEY || !process.env.WABA_TEMPLATE_NAME) {
    return { ok: false, skipped: true, reason: 'WABA env vars not set' };
  }
  try {
    const form = new URLSearchParams();
    form.set('userid',       process.env.WABA_USER_ID || '');
    form.set('wabaNumber',   process.env.WABA_NUMBER || '');
    form.set('mobile',       '91' + phone);
    form.set('templateName', process.env.WABA_TEMPLATE_NAME);
    form.set('msg',          buildTemplateMessage(name));
    form.set('sendMethod',   'quick');
    form.set('output',       'json');

    if (process.env.WABA_MEDIA_ID) {
      form.set('msgType', 'media'); form.set('mediaType', 'image'); form.set('mediaId', process.env.WABA_MEDIA_ID);
    } else if (process.env.WABA_MEDIA_URL) {
      form.set('msgType', 'media'); form.set('mediaType', 'image'); form.set('mediaUrl', process.env.WABA_MEDIA_URL);
    } else {
      form.set('msgType', 'text');
    }

    const waRes = await postFormInsecure(WABA_URL, { apikey: process.env.WABA_API_KEY }, form.toString());
    let data = null;
    try { data = JSON.parse(waRes.text); } catch (_) { data = waRes.text; }
    return { ok: waRes.status >= 200 && waRes.status < 300, status: waRes.status, data };
  } catch (e) {
    console.error('WABA send failed:', e);
    return { ok: false, error: errInfo(e) };
  }
}

/* WhatsApp body — must match the approved "for_marketing_y2b" template (no variables). */
function buildTemplateMessage(name) {
  return [
    '🙏',
    'Thankyou For Exploring Our Dream With Us..',
    "We're Truly Delighted to be a Part of Your Beautiful Journey Toward Finding the Perfect Space for Your Heart & Future.",
    "At, Yes2Broker, We Don't Just Offer Homes, We Offer Comfort, Trust & Care.",
    "If There's Anything You Need, We're Just a Call Away"
  ].join('\n');
}

/* POST x-www-form-urlencoded with relaxed TLS (vendor cert is for 1t.cl, not their vanity host). */
function postFormInsecure(urlString, headers, bodyString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      rejectUnauthorized: false,
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyString)
      }, headers)
    };
    const r = https.request(opts, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => resolve({ status: resp.statusCode, text: data }));
    });
    r.on('error', reject);
    r.write(bodyString);
    r.end();
  });
}

function errInfo(e) {
  const out = { message: String((e && e.message) || e) };
  const c = e && e.cause;
  if (c) out.cause = { message: String(c.message || c), code: c.code, errno: c.errno, host: c.host || c.hostname };
  return out;
}

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch (_) { return resolve({}); } }
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
