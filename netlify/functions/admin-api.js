// netlify/functions/admin-api.js
//
// Everything only YOU can do. Every call must carry a valid Supabase login whose
// email is listed in the ADMIN_EMAILS environment variable; anyone else gets 403.
//
// Actions: list, create_gallery, photos, sign_upload, delete_photo, set_downloads, publish, resend

const {
  json, enc, esc, cfg, configured, db, getUser, isAdmin, wrap, firstName,
  getOrCreateClient, newTag, sendEmail, signedUrl, apiSign, galleryPhotos, photoInGallery, cleanTag
} = require('./lib/shared');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadGallery(id) {
  if (!UUID.test(String(id || ''))) return null;
  const rows = await db(`galleries?id=eq.${id}&select=*,clients(id,name,email,phone,active)&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

// Invite (new client) or notify (existing account). Returns 'invited' | 'existing'. Throws on failure.
async function notifyClient(gallery, client) {
  const c = cfg();
  let kind, link;

  const r = await fetch(`${c.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: c.SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'invite', email: client.email, redirect_to: `${c.SITE}/login.html` })
  });
  const d = await r.json().catch(() => ({}));

  if (r.ok && d.action_link) {
    kind = 'invited';
    link = d.action_link; // secure one-time link to set a password, then lands on the login page
    if (d.id) { try { await db(`clients?id=eq.${client.id}`, { method: 'PATCH', body: { auth_user_id: d.id } }); } catch (e) { /* non-fatal */ } }
  } else if (r.status === 422 || /already|exists|registered/i.test(JSON.stringify(d))) {
    kind = 'existing';
    link = `${c.SITE}/login.html`;
  } else {
    throw new Error('Could not create the client login: ' + (d.msg || d.message || d.error_description || r.status));
  }

  const hi = firstName(client.name);
  const title = esc(gallery.title);
  const btn = (href, label) => `<p style="margin:22px 0;"><a href="${esc(href)}" style="background:#d4af37;color:#0a0a0a;text-decoration:none;padding:12px 22px;font-size:15px;font-weight:bold;display:inline-block;">${label}</a></p>`;

  const html = kind === 'invited'
    ? wrap(`<p style="font-size:16px;margin:0 0 14px;">Hi ${esc(hi)},</p>
<p style="font-size:15px;line-height:1.7;color:#c9a227;margin:0 0 6px;">Your photos are ready! Your private gallery <b>${title}</b> is now available.</p>
<p style="font-size:15px;line-height:1.7;color:#c9a227;margin:0;">Click below to choose a password and open your gallery. You can mark your favourites and tell me which photos to edit or print.</p>
${btn(link, 'Set password &amp; view my gallery')}
<p style="font-size:12px;line-height:1.6;color:#a08830;margin:0;">This link works once. If it has expired, go to ${esc(c.SITE)}/login.html and choose "First time or forgot your password?".</p>`)
    : wrap(`<p style="font-size:16px;margin:0 0 14px;">Hi ${esc(hi)},</p>
<p style="font-size:15px;line-height:1.7;color:#c9a227;margin:0 0 6px;">Your photos are ready! Your private gallery <b>${title}</b> is now available.</p>
<p style="font-size:15px;line-height:1.7;color:#c9a227;margin:0;">Sign in with the email you booked with to view it and mark your favourites.</p>
${btn(link, 'Open my gallery')}
<p style="font-size:12px;line-height:1.6;color:#a08830;margin:0;">Forgot your password? Choose "First time or forgot your password?" on the sign-in page.</p>`);
  const text = kind === 'invited'
    ? `Hi ${hi},\n\nYour photos are ready! Your private gallery "${gallery.title}" is now available.\n\nChoose a password and open your gallery:\n${link}\n\nThis link works once. If it has expired, go to ${c.SITE}/login.html and choose "First time or forgot your password?".\n\nMH Captures/Media`
    : `Hi ${hi},\n\nYour photos are ready! Your private gallery "${gallery.title}" is now available.\n\nSign in with the email you booked with:\n${link}\n\nMH Captures/Media`;

  const sent = await sendEmail({
    to: client.email,
    subject: 'Your photos are ready — MH Captures/Media',
    html, text
  });
  if (!sent.ok) throw new Error(sent.skipped ? 'Email is not set up yet (RESEND_API_KEY missing).' : 'The email could not be sent.');
  return kind;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!configured()) return json(500, { error: 'Server is not configured yet.' });

  const user = await getUser(event);
  if (!user) return json(401, { error: 'Please sign in.' });
  if (!isAdmin(user)) return json(403, { error: 'Not allowed.' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  const c = cfg();

  try {
    switch (b.action) {

      case 'list': {
        const rows = await db(
          'galleries?select=id,title,status,downloads_enabled,published_at,notified_at,notify_kind,created_at,' +
          'clients(id,name,email,phone),bookings(session_type,booking_type,referred_by,created_at,status)' +
          '&order=created_at.desc&limit=200'
        );
        return json(200, { galleries: rows, adminEmail: user.email });
      }

      case 'create_gallery': {
        const email = String(b.email || '').toLowerCase().trim();
        if (!email.includes('@')) return json(400, { error: 'Enter a valid email.' });
        const client = await getOrCreateClient({ email, name: String(b.name || '').trim(), phone: '' });
        const g = await db('galleries', {
          method: 'POST', prefer: 'return=representation',
          body: { client_id: client.id, title: String(b.title || 'Photo gallery').slice(0, 120), cloudinary_tag: newTag() }
        });
        return json(200, { gallery: g[0] });
      }

      case 'photos': {
        const g = await loadGallery(b.gallery);
        if (!g) return json(404, { error: 'Gallery not found.' });
        const [res, sels] = await Promise.all([
          galleryPhotos(g.cloudinary_tag),
          db(`selections?gallery_id=eq.${g.id}&select=photo_public_id,favourite,for_editing,for_printing,note`)
        ]);
        const byId = {};
        (sels || []).forEach((s) => { byId[s.photo_public_id] = s; });
        return json(200, {
          gallery: { id: g.id, title: g.title, status: g.status, downloads_enabled: g.downloads_enabled, notified_at: g.notified_at },
          photos: res.map((p) => ({
            id: p.public_id,
            thumb: signedUrl(p.public_id, p.format, p.version, 'c_limit,w_400,q_auto'),
            favourite: !!(byId[p.public_id] || {}).favourite,
            for_editing: !!(byId[p.public_id] || {}).for_editing,
            for_printing: !!(byId[p.public_id] || {}).for_printing,
            note: (byId[p.public_id] || {}).note || ''
          }))
        });
      }

      case 'sign_upload': {
        const g = await loadGallery(b.gallery);
        if (!g) return json(404, { error: 'Gallery not found.' });
        const timestamp = Math.floor(Date.now() / 1000);
        const params = { tags: cleanTag(g.cloudinary_tag), timestamp, type: 'authenticated' };
        return json(200, {
          cloud: c.CLOUD, apiKey: c.CKEY, timestamp, tags: params.tags, type: params.type,
          signature: apiSign(params)
        });
      }

      case 'delete_photo': {
        const g = await loadGallery(b.gallery);
        if (!g) return json(404, { error: 'Gallery not found.' });
        if (!(await photoInGallery(g.cloudinary_tag, b.photo))) return json(404, { error: 'Photo not found in this gallery.' });
        const timestamp = Math.floor(Date.now() / 1000);
        const params = { public_id: b.photo, timestamp, type: 'authenticated' };
        const form = new URLSearchParams({ ...params, timestamp: String(timestamp), api_key: c.CKEY, signature: apiSign(params) });
        const r = await fetch(`https://api.cloudinary.com/v1_1/${c.CLOUD}/image/destroy`, { method: 'POST', body: form });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || (d.result && d.result !== 'ok')) return json(502, { error: 'Could not delete that photo.' });
        await db(`selections?gallery_id=eq.${g.id}&photo_public_id=eq.${enc(b.photo)}`, { method: 'DELETE' });
        return json(200, { ok: true });
      }

      case 'set_downloads': {
        if (!UUID.test(String(b.gallery || ''))) return json(404, { error: 'Gallery not found.' });
        await db(`galleries?id=eq.${b.gallery}`, { method: 'PATCH', body: { downloads_enabled: b.enabled === true } });
        return json(200, { ok: true, downloads_enabled: b.enabled === true });
      }

      case 'publish': {
        const g = await loadGallery(b.gallery);
        if (!g) return json(404, { error: 'Gallery not found.' });
        const client = g.clients;
        if (!client || !client.email) return json(400, { error: 'This gallery has no client email yet.' });
        if (client.active === false) return json(400, { error: 'This client is switched off.' });

        const photos = await galleryPhotos(g.cloudinary_tag);
        if (!photos.length) return json(400, { error: 'Upload at least one photo first.' });

        // Atomic claim: only ONE request can flip draft -> published. A second click gets 409.
        const claimed = await db(`galleries?id=eq.${g.id}&status=eq.draft`, {
          method: 'PATCH', prefer: 'return=representation',
          body: { status: 'published', published_at: new Date().toISOString() }
        });
        if (!claimed || !claimed.length) {
          return json(409, { error: 'This gallery is already published. Use "Resend email" if the client needs it again.' });
        }

        try {
          const kind = await notifyClient(g, client);
          await db(`galleries?id=eq.${g.id}`, { method: 'PATCH', body: { notified_at: new Date().toISOString(), notify_kind: kind } });
          return json(200, { ok: true, kind, photos: photos.length });
        } catch (e) {
          // Put it back to draft so nothing is half-published and you can try again.
          await db(`galleries?id=eq.${g.id}`, { method: 'PATCH', body: { status: 'draft', published_at: null } });
          return json(502, { error: e.message });
        }
      }

      case 'resend': {
        const g = await loadGallery(b.gallery);
        if (!g) return json(404, { error: 'Gallery not found.' });
        if (g.status !== 'published') return json(400, { error: 'Publish the gallery first.' });
        // 10-minute cooldown, claimed atomically so a double click only sends once.
        const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const claimed = await db(
          `galleries?id=eq.${g.id}&or=(notified_at.is.null,notified_at.lt.${cutoff})`,
          { method: 'PATCH', prefer: 'return=representation', body: { notified_at: new Date().toISOString() } }
        );
        if (!claimed || !claimed.length) return json(429, { error: 'An email was sent in the last 10 minutes. Please wait a bit.' });
        try {
          const kind = await notifyClient(g, g.clients);
          await db(`galleries?id=eq.${g.id}`, { method: 'PATCH', body: { notify_kind: kind } });
          return json(200, { ok: true, kind });
        } catch (e) {
          await db(`galleries?id=eq.${g.id}`, { method: 'PATCH', body: { notified_at: g.notified_at } });
          return json(502, { error: e.message });
        }
      }

      default:
        return json(400, { error: 'Unknown action.' });
    }
  } catch (e) {
    console.error('admin-api error:', b.action, e.message);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};
