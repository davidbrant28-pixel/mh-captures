// netlify/functions/get-client-photos.js
//
// Returns ONLY the signed-in client's own PUBLISHED gallery.
//  - login is verified with Supabase
//  - the gallery is found through the client's verified email (never from anything the browser sends)
//  - download links are only created when you have turned downloads on for that gallery

const { json, enc, db, configured, getUser, signedUrl, galleryPhotos } = require('./lib/shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!configured()) return json(500, { error: 'Server is not configured yet.' });

  const user = await getUser(event);
  if (!user) return json(401, { error: 'Session expired. Please sign in again.' });

  let client, galleries;
  try {
    client = (await db(`clients?email=eq.${enc(user.email)}&select=id,name,active&limit=1`))[0];
    if (client && client.active !== false) {
      galleries = await db(
        `galleries?client_id=eq.${client.id}&status=eq.published` +
        `&select=id,title,cloudinary_tag,downloads_enabled,published_at&order=published_at.desc`
      );
    }
  } catch (e) {
    return json(502, { error: 'Could not load your gallery.' });
  }

  if (!client || client.active === false || !galleries || !galleries.length) {
    return json(404, { error: 'Your gallery is not ready yet. You will get an email from MH Captures/Media when it is.' });
  }

  const wanted = (event.queryStringParameters || {}).gallery;
  const g = galleries.find((x) => x.id === wanted) || galleries[0];
  const dl = g.downloads_enabled === true;

  let resources, sels;
  try {
    resources = await galleryPhotos(g.cloudinary_tag);
    sels = await db(`selections?gallery_id=eq.${g.id}&select=photo_public_id,favourite,for_editing,for_printing,note`);
  } catch (e) {
    return json(502, { error: 'Could not load photos.' });
  }
  const byId = {};
  (sels || []).forEach((s) => { byId[s.photo_public_id] = s; });

  const photos = resources.map((p) => {
    const s = byId[p.public_id] || {};
    const out = {
      id: p.public_id,
      thumb: signedUrl(p.public_id, p.format, p.version, 'c_limit,w_900,q_auto'),
      // When downloads are off, the big preview is smaller so it is not a free copy of the original.
      full: signedUrl(p.public_id, p.format, p.version, dl ? 'c_limit,w_2400,q_auto:good' : 'c_limit,w_1400,q_auto:eco'),
      width: p.width,
      height: p.height,
      favourite: !!s.favourite,
      for_editing: !!s.for_editing,
      for_printing: !!s.for_printing,
      note: s.note || ''
    };
    if (dl) out.download = signedUrl(p.public_id, p.format, p.version, 'fl_attachment');
    return out;
  });

  return json(200, {
    name: client.name || '',
    gallery: { id: g.id, title: g.title, downloadsEnabled: dl },
    galleries: galleries.map((x) => ({ id: x.id, title: x.title })),
    count: photos.length,
    photos
  });
};
