'use strict';
// Shared helpers for the client-gallery functions.
// Lives in a sub-folder so Netlify does NOT publish it as its own function.
const crypto = require('crypto');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const enc = encodeURIComponent;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function cfg() {
  const e = process.env;
  return {
    SUPABASE_URL: (e.SUPABASE_URL || '').replace(/\/$/, ''),
    PUB: e.SUPABASE_PUBLISHABLE_KEY || e.SUPABASE_ANON_KEY,
    SECRET: e.SUPABASE_SECRET_KEY || e.SUPABASE_SERVICE_ROLE_KEY,
    CLOUD: e.CLOUDINARY_CLOUD_NAME,
    CKEY: e.CLOUDINARY_API_KEY,
    CSECRET: e.CLOUDINARY_API_SECRET,
    SITE: (e.SITE_URL || 'https://mhcapturesmedia.com').replace(/\/$/, ''),
    ADMINS: (e.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
  };
}

function configured() {
  const c = cfg();
  return !!(c.SUPABASE_URL && c.PUB && c.SECRET && c.CLOUD && c.CKEY && c.CSECRET);
}

// ── Supabase REST (server side, secret key goes in the apikey header ONLY) ──
async function db(path, { method = 'GET', body, prefer } = {}) {
  const c = cfg();
  const headers = { apikey: c.SECRET, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${c.SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  if (!r.ok) {
    const err = new Error((data && (data.message || data.error)) || `Database error ${r.status}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Who is calling? Verifies the Supabase session token. Returns {id,email} or null.
async function getUser(event) {
  const c = cfg();
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  let r;
  try {
    r = await fetch(`${c.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: c.PUB }
    });
  } catch (e) { return null; }
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.email) return null;
  return { id: u.id, email: String(u.email).toLowerCase() };
}

const isAdmin = (user) => !!user && cfg().ADMINS.includes(user.email);

// ── Clients / bookings ──
async function findClientByEmail(email) {
  const rows = await db(`clients?email=eq.${enc(email)}&select=*&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

async function getOrCreateClient({ email, name, phone }) {
  let c = await findClientByEmail(email);
  if (!c) {
    try {
      const rows = await db('clients', {
        method: 'POST', prefer: 'return=representation',
        body: { email, name: name || null, phone: phone || null }
      });
      c = rows[0];
    } catch (e) {
      if (e.status === 409) c = await findClientByEmail(email); // created a moment ago by a parallel request
      else throw e;
    }
  } else {
    const patch = {};
    if (!c.name && name) patch.name = name;
    if (!c.phone && phone) patch.phone = phone;
    if (Object.keys(patch).length) {
      await db(`clients?id=eq.${c.id}`, { method: 'PATCH', body: patch });
    }
  }
  return c;
}

const newTag = () => 'gal-' + crypto.randomBytes(6).toString('hex');

// Creates (or reconnects) the client, records the booking, and makes a DRAFT gallery.
// Idempotent: the same externalRef (Stripe payment id, or "free:<email>") never creates a second booking.
// Never sends a login invitation.
async function registerBooking(b) {
  const email = (b.email || '').toLowerCase().trim();
  const client = email ? await getOrCreateClient({ email, name: b.name, phone: b.phone }) : null;

  const rows = await db('bookings?on_conflict=external_ref', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: {
      client_id: client ? client.id : null,
      external_ref: b.externalRef,
      booking_type: b.bookingType,
      session_type: b.session || null,
      referred_by: b.referredBy || null,
      amount_cents: b.amountCents || 0,
      contact_name: b.name || null,
      contact_email: email || null,
      contact_phone: b.phone || null,
      status: client ? 'requested' : 'needs_review',
      details: b.details || {}
    }
  });

  if (!rows || !rows.length) {
    // Already recorded (retry). Make sure its gallery exists, but don't treat as new.
    const ex = (await db(`bookings?external_ref=eq.${enc(b.externalRef)}&select=*&limit=1`))[0];
    if (ex && ex.client_id) {
      const gs = await db(`galleries?booking_id=eq.${ex.id}&select=id&limit=1`);
      if (!gs.length) {
        await db('galleries', {
          method: 'POST',
          body: { client_id: ex.client_id, booking_id: ex.id, title: `${b.session || 'Session'} — ${b.name || email}`, cloudinary_tag: newTag() }
        });
      }
    }
    return { duplicate: true };
  }

  const booking = rows[0];
  let gallery = null;
  if (client) {
    const g = await db('galleries', {
      method: 'POST', prefer: 'return=representation',
      body: { client_id: client.id, booking_id: booking.id, title: `${b.session || 'Session'} — ${b.name || email}`, cloudinary_tag: newTag() }
    });
    gallery = g[0];
  }
  return { duplicate: false, client, booking, gallery };
}

// ── Email (Resend) ──
async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, skipped: true };
  const from = process.env.RESEND_FROM || 'MH Captures/Media <gallery@mhcapturesmedia.com>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: 'mhmedia@mhcapturesmedia.com', subject, html, text })
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const wrap = (inner) => `<div style="background:#0a0a0a;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;border:1px solid #3a3320;padding:32px 28px;color:#d4af37;">
<div style="font-size:20px;letter-spacing:1px;margin-bottom:20px;">MH <i style="color:#a08c2a">Captures/Media</i></div>
${inner}
<div style="margin-top:28px;font-size:12px;color:#a08830;">MH Captures/Media · London, Ontario · mhmedia@mhcapturesmedia.com</div>
</div></div>`;

const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

// Booking acknowledgment: NOT a Stripe receipt, NOT a gallery invite.
async function sendBookingAck(reg, b) {
  const email = (b.email || '').toLowerCase().trim();
  if (!email || !reg || reg.duplicate) return { ok: false, skipped: true };
  const free = b.bookingType !== 'paid';
  const hi = firstName(b.name);
  const extra = free
    ? 'Your session is free, so there is nothing to pay.'
    : 'Your $30 deposit has been received. Stripe will email you a separate payment receipt.';
  const html = wrap(`
<p style="font-size:16px;line-height:1.6;margin:0 0 14px;">Hi ${esc(hi)},</p>
<p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#c9a227;">Thank you for your booking request${b.session ? ' for a <b>' + esc(b.session) + '</b> session' : ''}. ${extra}</p>
<p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#c9a227;"><b>I will confirm your requested date and time within 24 hours.</b> If I need anything else I will reply to this email.</p>
<p style="font-size:15px;line-height:1.7;margin:0;color:#c9a227;">Your private photo gallery link will be sent separately once your photos are ready.</p>`);
  const text = `Hi ${hi},\n\nThank you for your booking request${b.session ? ' for a ' + b.session + ' session' : ''}. ${extra}\n\nI will confirm your requested date and time within 24 hours. If I need anything else I will reply to this email.\n\nYour private photo gallery link will be sent separately once your photos are ready.\n\nMH Captures/Media`;
  const res = await sendEmail({ to: email, subject: 'We received your booking request — MH Captures/Media', html, text });
  if (res.ok && reg.booking) {
    try { await db(`bookings?id=eq.${reg.booking.id}`, { method: 'PATCH', body: { ack_sent_at: new Date().toISOString() } }); } catch (e) { /* non-fatal */ }
  }
  return res;
}

// The email to YOU (via your existing Formspree form) for a paid booking. Sent once, only after Stripe confirms payment.
async function sendOwnerPaidNotification(b) {
  const body = {
    _replyto: b.email || undefined,
    _subject: `New Paid Booking — $30 Deposit — ${b.session}`,
    name: b.name, email: b.email, phone: b.phone || 'Not provided', session: b.session,
    booking_type: 'Paid deposit ($30)', referred_by: b.referredBy || 'None',
    photo_release_signed: b.details && b.details.release_signature ? `YES — Signed by: ${b.details.release_signature}` : 'NO',
    message: `New paid booking (payment confirmed by Stripe):\n\nName: ${b.name}\nEmail: ${b.email || 'Not provided'}\nPhone: ${b.phone || 'Not provided'}\nSession: ${b.session}\nReferred by: ${b.referredBy || 'None'}\nPayment: ${b.externalRef}\n\nPHOTO RELEASE: ${b.details && b.details.release_signature ? 'SIGNED by ' + b.details.release_signature : 'NOT SIGNED'}`
  };
  try {
    const r = await fetch('https://formspree.io/f/mqpkeajb', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false }; }
}

// Used by the free-booking path: must NEVER break the existing booking flow.
async function registerAndAck(b) {
  try {
    const reg = await registerBooking(b);
    if (!reg.duplicate) await sendBookingAck(reg, b);
  } catch (e) {
    console.error('registerAndAck failed (booking itself was not affected):', e.message);
  }
}

// ── Cloudinary ──
function signDelivery(publicId, format, transformation) {
  const secret = cfg().CSECRET;
  const toSign = (transformation ? transformation + '/' : '') + publicId + '.' + format;
  const sig = crypto.createHash('sha1').update(toSign + secret).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').substring(0, 8);
  return sig;
}

function signedUrl(publicId, format, version, transformation) {
  const c = cfg();
  const sig = signDelivery(publicId, format, transformation);
  return `https://res.cloudinary.com/${c.CLOUD}/image/authenticated/s--${sig}--/` +
    (transformation ? transformation + '/' : '') + `v${version}/${publicId}.${format}`;
}

// Signature for Cloudinary API calls (upload / destroy): sorted params + secret, SHA-1 hex.
function apiSign(params) {
  const s = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(s + cfg().CSECRET).digest('hex');
}

async function cloudSearch(expression) {
  const c = cfg();
  const basic = Buffer.from(`${c.CKEY}:${c.CSECRET}`).toString('base64');
  const r = await fetch(`https://api.cloudinary.com/v1_1/${c.CLOUD}/resources/search`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression, sort_by: [{ created_at: 'asc' }], max_results: 500 })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Photo search failed');
  return data.resources || [];
}

const cleanTag = (t) => String(t).replace(/[^A-Za-z0-9_\-]/g, '');
const galleryPhotos = (tag) =>
  cloudSearch(`tags="${cleanTag(tag)}" AND type=authenticated AND resource_type=image`);

// Is this public_id really inside this gallery's tag?
async function photoInGallery(tag, publicId) {
  const pid = String(publicId || '').replace(/["\\]/g, '');
  if (!pid) return false;
  const rows = await cloudSearch(`tags="${cleanTag(tag)}" AND public_id="${pid}" AND type=authenticated`);
  return rows.some((r) => r.public_id === publicId);
}

module.exports = {
  json, enc, esc, cfg, configured, db, getUser, isAdmin, wrap, firstName,
  findClientByEmail, getOrCreateClient, newTag, registerBooking, registerAndAck,
  sendEmail, sendBookingAck, sendOwnerPaidNotification, signedUrl, apiSign, galleryPhotos, photoInGallery, cleanTag
};
