/**
 * Vercel Serverless Function  ·  /api/submit
 * ------------------------------------------------------------------
 *  POST  -> create lead in LeadPlus CRM + send WhatsApp template
 *  GET                      -> health check (which env vars are set)
 *  GET ?selftest=<10-digit> -> run a TEST lead through the real path
 *                              and return the raw CRM + WhatsApp responses
 *
 *  Required env vars (Vercel → Settings → Environment Variables):
 *    LEADPLUS_VENDOR_KEY, WABA_API_KEY, WABA_USER_ID, WABA_NUMBER, WABA_TEMPLATE_NAME
 *  Optional (image-header templates only): WABA_MEDIA_URL or WABA_MEDIA_ID
 * ------------------------------------------------------------------
 */

const LEADPLUS_URL = 'https://yesbroker.leadpluss.com/Services/api/TenantLeads/Submit';
const WABA_URL     = 'https://Waba.atsocialapi.com/WAApi/send';

module.exports = async (req, res) => {

  // ---- GET: health check + optional self-test ----
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const selftest = url.searchParams.get('selftest');

    if (selftest) {
      const phone = String(selftest).replace(/\D/g, '');
      if (phone.length !== 10) {
        res.status(400).json({ ok: false, error: 'selftest needs a 10-digit phone, e.g. ?selftest=9512516886' });
        return;
      }
      const testLead = {
        FirstName: 'Test', LastName: 'Diagnostic', ISD: '+91', Phone: phone, EmailId: '',
        State: 'Gujarat', City: 'Ahmedabad', Location: 'Motera', Project: 'Shivansh Parmanand',
        PropertyFor: 'Buy', Property: 'Flat', PropertyType: '3 BHK', Budget: 5000000,
        Reference: 'Other', Message: 'SELFTEST — please delete this lead', LeadSource: 'Walk In'
      };
      const result = await processLead(testLead);
      res.status(200).json({ note: 'This is a TEST lead — delete it from the CRM afterwards.', ...result });
      return;
    }

    res.status(200).json({
      ok: true,
      service: 'y2b-lead-submit',
      node: process.version,
      env: {
        LEADPLUS_VENDOR_KEY: !!process.env.LEADPLUS_VENDOR_KEY,
        WABA_API_KEY:        !!process.env.WABA_API_KEY,
        WABA_USER_ID:        !!process.env.WABA_USER_ID,
        WABA_NUMBER:         !!process.env.WABA_NUMBER,
        WABA_TEMPLATE_NAME:  !!process.env.WABA_TEMPLATE_NAME
      }
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  // ---- POST: real submission ----
  try {
    const body = await readJson(req);
    const lead = body.lead || {};

    const phone = String(lead.Phone || '').replace(/\D/g, '');
    if (!lead.FirstName || phone.length !== 10) {
      res.status(400).json({ ok: false, error: 'Invalid lead data', got: { hasName: !!lead.FirstName, phoneLen: phone.length } });
      return;
    }

    const result = await processLead(lead);

    if (!result.crm.ok) {
      res.status(502).json({ ok: false, stage: 'crm', ...result });
      return;
    }
    res.status(200).json({ ok: true, crm: true, whatsapp: result.whatsapp });

  } catch (err) {
    console.error('submit handler error:', err);
    res.status(500).json({ ok: false, error: 'Server error', detail: String(err) });
  }
};

/* Core: send to CRM (primary) then WhatsApp (best-effort). Returns raw details. */
async function processLead(lead) {
  const phone = String(lead.Phone || '').replace(/\D/g, '');

  // 1) LeadPlus CRM
  let crm = { ok: false };
  try {
    const crmPayload = Object.assign({}, lead, { vendor_key: process.env.LEADPLUS_VENDOR_KEY });
    const crmRes = await fetch(LEADPLUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(crmPayload)
    });
    let crmData = null;
    const text = await crmRes.text();
    try { crmData = JSON.parse(text); } catch (_) { crmData = text; }   // capture even non-JSON replies
    crm = { ok: crmRes.ok, status: crmRes.status, data: crmData };
  } catch (e) {
    crm = { ok: false, error: String(e) };
    console.error('CRM call failed:', e);
  }

  // 2) WhatsApp template (best-effort)
  let whatsapp = { sent: false, skipped: false };
  if (process.env.WABA_API_KEY && process.env.WABA_TEMPLATE_NAME) {
    try {
      const form = new URLSearchParams();
      form.set('userid',       process.env.WABA_USER_ID || '');
      form.set('wabaNumber',   process.env.WABA_NUMBER || '');
      form.set('mobile',       '91' + phone);
      form.set('templateName', process.env.WABA_TEMPLATE_NAME);
      form.set('msg',          buildTemplateMessage(lead));
      form.set('sendMethod',   'quick');
      form.set('output',       'json');

      if (process.env.WABA_MEDIA_ID) {
        form.set('msgType', 'media'); form.set('mediaType', 'image'); form.set('mediaId', process.env.WABA_MEDIA_ID);
      } else if (process.env.WABA_MEDIA_URL) {
        form.set('msgType', 'media'); form.set('mediaType', 'image'); form.set('mediaUrl', process.env.WABA_MEDIA_URL);
      } else {
        form.set('msgType', 'text');
      }

      const waRes = await fetch(WABA_URL, {
        method: 'POST',
        headers: { 'apikey': process.env.WABA_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      let waData = null;
      const t = await waRes.text();
      try { waData = JSON.parse(t); } catch (_) { waData = t; }
      whatsapp = { sent: waRes.ok, status: waRes.status, data: waData };
    } catch (e) {
      whatsapp = { sent: false, error: String(e) };
      console.error('WABA send failed:', e);
    }
  } else {
    whatsapp.skipped = true;
  }

  return { crm, whatsapp };
}

/* WhatsApp body — must match the approved "for_marketing_y2b" template (no variables). */
function buildTemplateMessage(lead) {
  return [
    '🙏',
    'Thankyou For Exploring Our Dream With Us..',
    "We're Truly Delighted to be a Part of Your Beautiful Journey Toward Finding the Perfect Space for Your Heart & Future.",
    "At, Yes2Broker, We Don't Just Offer Homes, We Offer Comfort, Trust & Care.",
    "If There's Anything You Need, We're Just a Call Away"
  ].join('\n');
}

/* Read + parse JSON body whether or not the runtime pre-parsed it */
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
