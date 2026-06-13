/**
 * Vercel Serverless Function · /api/whatsapp
 * ------------------------------------------------------------------
 * Sends a per-project WhatsApp template. The template details live in
 * Supabase (per project); only the account-level WABA secrets live in env.
 *
 *  POST { slug, name, phone }  -> looks up the project's template, sends it
 *  GET                          -> health check (which env vars are set)
 *  GET ?selftest=<phone>&slug=<slug> -> sends a test, returns raw response
 *
 * Per-project columns in Supabase `projects`:
 *   wa_template    (text)  template name; if empty, WhatsApp is skipped
 *   wa_media_type  (text)  'image' | 'video' | null  (null = text template)
 *   wa_media_url   (text)  public https link to the header image/video
 *
 * Env vars (account-level secrets):
 *   WABA_API_KEY, WABA_USER_ID, WABA_NUMBER
 * ------------------------------------------------------------------
 */

const WABA_URL          = 'https://Waba.atsocialapi.com/WAApi/send';
const SUPABASE_URL      = 'https://avgaespihpokalwnohkr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2Z2Flc3BpaHBva2Fsd25vaGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTkyNDAsImV4cCI6MjA5NjczNTI0MH0.gEESCAzCHSl9AxssmSjfKK4_wN8BixhLibQtMqGj0IY';
const https             = require('https');

module.exports = async (req, res) => {

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const isTest = !!url.searchParams.get('selftest');
    const phone  = String(url.searchParams.get('phone') || url.searchParams.get('selftest') || '').replace(/\D/g, '');
    const slug   = (url.searchParams.get('slug') || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
    const name   = url.searchParams.get('name') || (isTest ? 'Test' : 'there');

    // Real send (used by the form) OR self-test — both need phone + slug
    if (phone.length === 10 && slug) {
      res.status(200).json(await sendForSlug(slug, name, phone));
      return;
    }

    // Otherwise: health check
    res.status(200).json({
      ok: true, service: 'y2b-whatsapp', node: process.version,
      env: {
        WABA_API_KEY: !!process.env.WABA_API_KEY,
        WABA_USER_ID: !!process.env.WABA_USER_ID,
        WABA_NUMBER:  !!process.env.WABA_NUMBER
      }
    });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }

  try {
    const body  = await readJson(req);
    const phone = String(body.phone || '').replace(/\D/g, '');
    const slug  = String(body.slug || '').replace(/[^a-z0-9-]/gi, '').toLowerCase();
    if (phone.length !== 10 || !slug) { res.status(400).json({ ok: false, error: 'Invalid phone or slug' }); return; }

    res.status(200).json(await sendForSlug(slug, body.name || 'there', phone));
  } catch (err) {
    console.error('whatsapp handler error:', err);
    res.status(500).json({ ok: false, error: 'Server error', detail: String(err) });
  }
};

/* Look up the project's template in Supabase, then send via WABA */
async function sendForSlug(slug, name, phone) {
  if (!process.env.WABA_API_KEY) return { ok: false, skipped: true, reason: 'WABA env not set' };

  // 1) fetch this project's WhatsApp template config (public read, RLS = active only)
  let cfg;
  try {
    const url = SUPABASE_URL + '/rest/v1/projects?slug=eq.' + slug +
                '&active=eq.true&select=wa_template,wa_media_type,wa_media_url';
    const r = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY } });
    const rows = await r.json();
    cfg = rows && rows[0];
  } catch (e) {
    return { ok: false, error: 'Could not load project template', detail: String(e) };
  }
  if (!cfg) return { ok: false, error: 'Project not found for slug: ' + slug };
  if (!cfg.wa_template) return { ok: false, skipped: true, reason: 'No wa_template set for this project' };

  // 2) build + send
  try {
    const form = new URLSearchParams();
    form.set('userid',       process.env.WABA_USER_ID || '');
    form.set('wabaNumber',   process.env.WABA_NUMBER || '');
    form.set('mobile',       '91' + phone);
    form.set('templateName', cfg.wa_template);
    form.set('msg',          '');                  // body comes from the approved template
    form.set('sendMethod',   'quick');
    form.set('output',       'json');

    if (cfg.wa_media_type && cfg.wa_media_url) {
      form.set('msgType',   'media');
      form.set('mediaType', cfg.wa_media_type);      // image | video
      form.set('mediaUrl',  cfg.wa_media_url);
    } else {
      form.set('msgType', 'text');
    }

    const waRes = await postFormInsecure(WABA_URL, { apikey: process.env.WABA_API_KEY }, form.toString());
    let data = null;
    try { data = JSON.parse(waRes.text); } catch (_) { data = waRes.text; }
    return { ok: waRes.status >= 200 && waRes.status < 300, status: waRes.status, template: cfg.wa_template, data };
  } catch (e) {
    console.error('WABA send failed:', e);
    return { ok: false, error: errInfo(e) };
  }
}

/* POST x-www-form-urlencoded with relaxed TLS (vendor cert is for 1t.cl, not their vanity host) */
function postFormInsecure(urlString, headers, bodyString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const opts = {
      method: 'POST', hostname: u.hostname, port: u.port || 443,
      path: u.pathname + (u.search || ''), rejectUnauthorized: false,
      headers: Object.assign({
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyString)
      }, headers)
    };
    const r = https.request(opts, (resp) => {
      let data = ''; resp.on('data', (c) => (data += c));
      resp.on('end', () => resolve({ status: resp.statusCode, text: data }));
    });
    r.on('error', reject); r.write(bodyString); r.end();
  });
}

function errInfo(e) {
  const out = { message: String((e && e.message) || e) };
  const c = e && e.cause;
  if (c) out.cause = { message: String(c.message || c), code: c.code };
  return out;
}

function readJson(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') { try { return resolve(JSON.parse(req.body)); } catch (_) { return resolve({}); } }
    let data = ''; req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
