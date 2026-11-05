// netlify/functions/stripe-webhook.js
//
// Stripe tells THIS function directly when a deposit succeeds, so a client is
// registered even if they close the page right after paying.
// The signature is verified, so nobody can fake a payment by calling this URL.
//
// Env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_...), plus the Supabase vars.
// Stripe Dashboard -> Developers -> Webhooks -> add endpoint:
//   https://mhcapturesmedia.com/.netlify/functions/stripe-webhook   event: payment_intent.succeeded

const { json, registerBooking, sendBookingAck, sendOwnerPaidNotification } = require('./lib/shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = (event.headers || {})['stripe-signature'] || (event.headers || {})['Stripe-Signature'];
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : (event.body || '');

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return json(400, { error: 'Invalid signature' });
  }

  if (evt.type !== 'payment_intent.succeeded') return json(200, { received: true, ignored: evt.type });

  const pi = evt.data.object;
  const m = pi.metadata || {};

  // Only deposits created by the booking form carry this key.
  if (m.release_signed === undefined) return json(200, { received: true, ignored: 'not a booking deposit' });

  // Work out the customer's email/phone. Wallet payments may not have put them in metadata.
  let email = (m.customer_email || pi.receipt_email || '').trim();
  let phone = (m.customer_phone || '').trim();
  let name = (m.customer_name || '').trim();
  if ((!email || !phone || !name) && pi.latest_charge) {
    try {
      const ch = await stripe.charges.retrieve(typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge.id);
      const bd = ch.billing_details || {};
      email = email || bd.email || '';
      phone = phone || bd.phone || '';
      name = name || bd.name || '';
    } catch (e) { /* fall through; booking is saved as needs_review if no email */ }
  }

  const booking = {
    email, name, phone,
    session: m.session_type || 'Session',
    referredBy: m.referred_by || '',
    bookingType: 'paid',
    amountCents: pi.amount_received || pi.amount || 0,
    externalRef: pi.id,
    details: {
      involves_minor: m.involves_minor === 'yes',
      minor_name: m.minor_name || '',
      guardian_name: m.guardian_name || '',
      release_signature: m.release_signature || '',
      stripe_event: evt.id
    }
  };

  try {
    const reg = await registerBooking(booking);
    if (!reg.duplicate) {
      try { await sendOwnerPaidNotification(booking); } catch (e) { console.error('owner notification failed:', e.message); }
      try { await sendBookingAck(reg, booking); } catch (e) { console.error('ack failed:', e.message); }
    }
    return json(200, { received: true, duplicate: !!reg.duplicate });
  } catch (e) {
    console.error('webhook registerBooking failed:', e.message);
    return json(500, { error: 'Could not record booking' }); // Stripe will retry; safe because it is idempotent
  }
};
