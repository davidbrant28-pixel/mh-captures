// netlify/functions/get-client-photos.js
//
// Verifies the client's Supabase login, looks up which Cloudinary tag belongs
// to that client, and returns signed URLs for only their photos.
//
// Netlify environment variables required:
//   SUPABASE_URL                e.g. https://abcdxyz.supabase.co
//   SUPABASE_PUBLISHABLE_KEY    sb_publishable_... (public key)
//   SUPABASE_SECRET_KEY         sb_secret_... (SECRET, never put in a page)
// (Old names SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY still work as a fallback.)
//   CLOUDINARY_CLOUD_NAME       e1ncafja
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET

const crypto = require('crypto');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// Cloudinary signed delivery URL for assets uploaded as type "authenticated"
function signedUrl(cloud, secret, publicId, format, version, transformation) {
  const toSign = (transformation ? transformation + '/' : '') + publicId + '.' + format;
  const sig = crypto
    .createHash('sha1')
    .update(toSign + secret)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .substring(0, 8);
  return (
    `https://res.cloudinary.com/${cloud}/image/authenticated/s--${sig}--/` +
    (transformation ? transformation + '/' : '') +
    `v${version}/${publicId}.${format}`
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const {
    SUPABASE_URL,
    CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
  } = process.env;
  const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY ||
      !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return json(500, { error: 'Server is not configured yet.' });
  }

  // 1. Who is asking? Verify the Supabase session token.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Please sign in.' });

  let user;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: PUBLISHABLE_KEY }
    });
    if (!r.ok) return json(401, { error: 'Session expired. Please sign in again.' });
    user = await r.json();
  } catch (e) {
    return json(502, { error: 'Could not verify your login.' });
  }

  const email = (user.email || '').toLowerCase();
  if (!email) return json(401, { error: 'Please sign in.' });

  // 2. Which photos belong to this client? (secret key bypasses row security).
  //    New-style secret keys are NOT JWTs: send in the apikey header only, never as a Bearer token.
  let client;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/clients?email=eq.${encodeURIComponent(email)}&select=name,tag,active&limit=1`,
      { headers: { apikey: SECRET_KEY } }
    );
    const rows = await r.json();
    client = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    return json(502, { error: 'Could not load your gallery.' });
  }

  if (!client || client.active === false || !client.tag) {
    return json(404, { error: 'No gallery is set up for this account yet.' });
  }

  // 3. Fetch only photos with this client's tag that are "authenticated" type.
  let resources = [];
  try {
    const basic = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');
    const safeTag = String(client.tag).replace(/"/g, '');
    const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/search`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: `tags="${safeTag}" AND type=authenticated AND resource_type=image`,
        sort_by: [{ created_at: 'asc' }],
        max_results: 500
      })
    });
    const data = await r.json();
    if (!r.ok) return json(502, { error: 'Could not load photos.' });
    resources = data.resources || [];
  } catch (e) {
    return json(502, { error: 'Could not load photos.' });
  }

  const photos = resources.map((p) => ({
    thumb: signedUrl(CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_SECRET, p.public_id, p.format, p.version, 'c_limit,w_900,q_auto'),
    full: signedUrl(CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_SECRET, p.public_id, p.format, p.version, 'c_limit,w_2400,q_auto:good'),
    download: signedUrl(CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_SECRET, p.public_id, p.format, p.version, 'fl_attachment'),
    width: p.width,
    height: p.height
  }));

  return json(200, { name: client.name || '', count: photos.length, photos });
};
