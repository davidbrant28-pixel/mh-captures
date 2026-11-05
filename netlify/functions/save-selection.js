// netlify/functions/save-selection.js
//
// Saves a client's favourite / "edit this" / "print this" picks for one photo.
// The server checks: valid login -> this is the client's own PUBLISHED gallery ->
// the photo really belongs to that gallery. The browser only sends ids, never the owner.

const { json, enc, db, configured, getUser, photoInGallery } = require('./lib/shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!configured()) return json(500, { error: 'Server is not configured yet.' });

  const user = await getUser(event);
  if (!user) return json(401, { error: 'Session expired. Please sign in again.' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  if (!b.gallery || !b.photo) return json(400, { error: 'Missing gallery or photo.' });

  try {
    const client = (await db(`clients?email=eq.${enc(user.email)}&select=id,active&limit=1`))[0];
    if (!client || client.active === false) return json(404, { error: 'No gallery found.' });

    const g = (await db(
      `galleries?id=eq.${enc(String(b.gallery))}&client_id=eq.${client.id}&status=eq.published&select=id,cloudinary_tag&limit=1`
    ))[0];
    if (!g) return json(404, { error: 'No gallery found.' });

    if (!(await photoInGallery(g.cloudinary_tag, b.photo))) return json(404, { error: 'Photo not found.' });

    const row = {
      gallery_id: g.id,
      photo_public_id: String(b.photo),
      favourite: b.favourite === true,
      for_editing: b.for_editing === true,
      for_printing: b.for_printing === true,
      note: String(b.note || '').slice(0, 500),
      updated_at: new Date().toISOString()
    };
    await db('selections?on_conflict=gallery_id,photo_public_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates', body: row
    });
    return json(200, { ok: true });
  } catch (e) {
    return json(502, { error: 'Could not save. Please try again.' });
  }
};
