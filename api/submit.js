/**
 * Vercel Serverless Function  ·  /api/submit
 * ------------------------------------------------------------------
 * Receives a lead from the form, then:
 *   1) creates the lead in LeadPlus CRM   (primary — must succeed)
 *   2) sends a WhatsApp template to the customer via WABA (best-effort)
 *
 * All secrets are read from Environment Variables (set in Vercel),
 * so nothing sensitive ever reaches the browser.
 *
 * Required env vars (Vercel → Project → Settings → Environment Variables):
 *   LEADPLUS_VENDOR_KEY   - your LeadPlus vendor key
 *   WABA_API_KEY          - WABA apikey
 *   WABA_USER_ID          - WABA account userid
 *   WABA_NUMBER           - your WhatsApp Business number WITH country code (e.g. 9198XXXXXXXX)
 *   WABA_TEMPLATE_NAME    - the EXACT approved template name to send
 *
 * If the WABA_* vars are missing, the lead is still saved to CRM and the
 * WhatsApp step is simply skipped — so you can deploy before WABA is ready.
 * ------------------------------------------------------------------
 */

const LEADPLUS_URL = 'https://yesbroker.leadpluss.com/Services/api/TenantLeads/Submit';
const WABA_URL     = 'https://Waba.atsocialapi.com/WAApi/send';

module.exports = async (req, res) => {
  // Health check: GET /api/submit shows which env vars are configured
  // (true/false only — never the secret values themselves).
  if (req.method === 'GET') {
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

  try {
    const body = await readJson(req);
    const lead = body.lead || {};

    // Minimal sanity check
    const phone = String(lead.Phone || '').replace(/\D/g, '');
    if (!lead.FirstName || phone.length !== 10) {
      res.status(400).json({ ok: false, error: 'Invalid lead data' });
      return;
    }

    // ---------- 1) LeadPlus CRM (primary) ----------
    const crmPayload = Object.assign({}, lead, {
      vendor_key: process.env.LEADPLUS_VENDOR_KEY
    });

    const crmRes = await fetch(LEADPLUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(crmPayload)
    });

    let crmData = null;
    try { crmData = await crmRes.json(); } catch (_) {}

    if (!crmRes.ok) {
      res.status(502).json({ ok: false, stage: 'crm', status: crmRes.status, data: crmData });
      return;
    }

    // ---------- 2) WhatsApp template (best-effort) ----------
    let whatsapp = { sent: false, skipped: false };

    if (process.env.WABA_API_KEY && process.env.WABA_TEMPLATE_NAME) {
      try {
        const form = new URLSearchParams();
        form.set('userid',       process.env.WABA_USER_ID || '');
        form.set('wabaNumber',   process.env.WABA_NUMBER || '');
        form.set('mobile',       '91' + phone);                 // recipient w/ country code
        form.set('templateName', process.env.WABA_TEMPLATE_NAME);
        form.set('msg',          buildTemplateMessage(lead));   // must match approved template body
        form.set('sendMethod',   'quick');
        form.set('output',       'json');

        // "yolocam" has an IMAGE header → must be sent as a media template.
        // Provide the header image with ONE of these env vars:
        //   WABA_MEDIA_ID  - media id from the panel's Media Library  (preferred)
        //   WABA_MEDIA_URL - a public https link to the image (jpg/png)
        // If neither is set it falls back to a plain text template.
        if (process.env.WABA_MEDIA_ID) {
          form.set('msgType',   'media');
          form.set('mediaType', 'image');
          form.set('mediaId',   process.env.WABA_MEDIA_ID);
        } else if (process.env.WABA_MEDIA_URL) {
          form.set('msgType',   'media');
          form.set('mediaType', 'image');
          form.set('mediaUrl',  process.env.WABA_MEDIA_URL);
        } else {
          form.set('msgType',   'text');
        }

        const waRes = await fetch(WABA_URL, {
          method: 'POST',
          headers: {
            'apikey': process.env.WABA_API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: form.toString()
        });

        let waData = null;
        try { waData = await waRes.json(); } catch (_) {}
        whatsapp = { sent: waRes.ok, status: waRes.status, data: waData };
      } catch (e) {
        // Never fail the lead because WhatsApp failed — just log it.
        whatsapp = { sent: false, error: String(e) };
        console.error('WABA send failed:', e);
      }
    } else {
      whatsapp.skipped = true; // WABA not configured yet
    }

    // CRM is the source of truth: the lead is saved, so this is a success.
    res.status(200).json({ ok: true, crm: true, whatsapp });

  } catch (err) {
    console.error('submit handler error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
};

/**
 * Build the WhatsApp message body.
 * This MUST match the approved "for_marketing_y2b" template body exactly.
 * That template has no variables, so the text is fully static.
 */
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
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
