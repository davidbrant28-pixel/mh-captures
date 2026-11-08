const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

function sendNotification(data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      _replyto: data.email,
      _subject: data.subject,
      name: data.name,
      email: data.email,
      phone: data.phone || 'Not provided',
      session: data.session,
      booking_type: data.type,
      referred_by: data.referredBy || 'None',
      photo_release_signed: data.releaseSignature ? `YES — Signed by: ${data.releaseSignature}` : 'NO',
      message: `New booking received:\n\nName: ${data.name}\nEmail: ${data.email}\nPhone: ${data.phone || 'Not provided'}\nSession: ${data.session}\nType: ${data.type}\nReferred by: ${data.referredBy || 'None'}\n\nPHOTO RELEASE: ${data.releaseSignature ? 'SIGNED by ' + data.releaseSignature : 'NOT SIGNED'}`,
    });

    const options = {
      hostname: 'formspree.io',
      path: '/f/mqpkeajb',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => { resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

// Emails the CUSTOMER an acknowledgment for a free booking (sent through Resend).
// Needs the Netlify setting RESEND_API_KEY. If it is missing or fails, the booking still works.
async function sendFreeBookingEmail({ email, name, session, referral }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !email) return;
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const why = referral
    ? 'Your referral has been verified, so your session is free.'
    : 'As a first-time client, your session is free.';
  const what = session ? ` for a <b>${esc(session)}</b> session` : '';
  const text = `Hi ${first},\n\nThank you for booking${session ? ' a ' + session + ' session' : ''} with MH Captures/Media. ${why} There is nothing to pay.\n\nI will confirm your requested date and time within 24 hours. If I need anything else, I will reply to this email.\n\nAfter your session, your edited photos will be delivered to your private online gallery. I will email you a link to set up your login when it is ready, usually within 48 hours.\n\nMH Captures/Media\nLondon, Ontario\nmhmedia@mhcapturesmedia.com`;
  const html = `<div style="background:#0a0a0a;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;"><div style="max-width:520px;margin:0 auto;border:1px solid #3a3320;padding:32px 28px;color:#d4af37;">
<div style="font-size:20px;letter-spacing:1px;margin-bottom:20px;">MH <i style="color:#a08c2a">Captures/Media</i></div>
<p style="font-size:16px;line-height:1.6;margin:0 0 14px;">Hi ${esc(first)},</p>
<p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#c9a227;">Thank you for booking${what} with MH Captures/Media. ${why} There is nothing to pay.</p>
<p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#c9a227;"><b>I will confirm your requested date and time within 24 hours.</b> If I need anything else, I will reply to this email.</p>
<p style="font-size:15px;line-height:1.7;margin:0;color:#c9a227;">After your session, your edited photos will be delivered to your private online gallery. I will email you a link to set up your login when it is ready, usually within 48 hours.</p>
<div style="margin-top:28px;font-size:12px;color:#a08830;">MH Captures/Media · London, Ontario · mhmedia@mhcapturesmedia.com</div></div></div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'MH Captures/Media <mhmedia@mhcapturesmedia.com>',
        to: [email], reply_to: 'mhmedia@mhcapturesmedia.com',
        subject: 'We received your booking request — MH Captures/Media', html, text
      })
    });
    if (!r.ok) console.error('Free booking email failed:', r.status);
  } catch (e) {
    console.error('Free booking email error:', e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { amount, session, name, email, phone, referredBy, involvesMinor, minorName, guardianName, checkFreeEligibility, releaseSignature } = JSON.parse(event.body);

    if (checkFreeEligibility) {
      if (!email || !email.includes('@')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
      }

      const cleanEmail = email.toLowerCase().trim();
      const cleanName = (name || '').toLowerCase().trim();
      const cleanPhone = (phone || '').replace(/\D/g, '');
      const allCustomers = await stripe.customers.list({ limit: 100 });

      for (const customer of allCustomers.data) {
        const customerEmail = (customer.email || '').toLowerCase();
        const customerName = (customer.name || '').toLowerCase();
        const customerPhone = (customer.phone || '').replace(/\D/g, '');

        if (customerEmail === cleanEmail) {
          if (customer.metadata && customer.metadata.first_time_free === 'yes') {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'This email has already claimed a free session.' }) };
          }
          const charges = await stripe.charges.list({ customer: customer.id, limit: 1 });
          if (charges.data.length > 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'This email has already booked a session. The free offer is for new clients only.' }) };
          }
        }

        if (cleanName && customerName && customerName === cleanName) {
          if (cleanPhone && customerPhone && customerPhone === cleanPhone) {
            if (customer.metadata && customer.metadata.first_time_free === 'yes') {
              return { statusCode: 400, headers, body: JSON.stringify({ error: 'This name and phone number have already been used to claim a free session.' }) };
            }
          } else if (!cleanPhone) {
            if (customer.metadata && customer.metadata.first_time_free === 'yes') {
              return { statusCode: 400, headers, body: JSON.stringify({ error: 'This name has already been used. Please add your phone number to continue.' }) };
            }
          }
        }

        if (cleanPhone && customerPhone && customerPhone === cleanPhone) {
          if (customer.metadata && customer.metadata.first_time_free === 'yes') {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'This phone number has already been used to claim a free session.' }) };
          }
        }
      }

      if (referredBy && referredBy.trim().length > 0) {
        const referralName = referredBy.trim().toLowerCase();
        if (cleanName && (cleanName.includes(referralName) || referralName.includes(cleanName.split(' ')[0]))) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'You cannot use your own name as a referral.' }) };
        }
        const match = allCustomers.data.find(c => c.name && c.name.toLowerCase().includes(referralName));
        if (!match) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `We could not find "${referredBy}" as a registered client. Please check the spelling and try again.` }) };
        }
        if (match.email && match.email.toLowerCase() === cleanEmail) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'You cannot refer yourself.' }) };
        }
        await stripe.customers.create({
          email: cleanEmail, name: name || '', phone: phone || '',
          metadata: { first_time_free: 'yes', session_type: session || '', referred_by: referredBy, claimed_at: new Date().toISOString() }
        });
        await sendNotification({ subject: `New Free Booking (Referral) — ${session}`, name, email, phone, session, referredBy, type: 'Free session (referral)', releaseSignature });
        await sendFreeBookingEmail({ email: cleanEmail, name, session, referral: true });
        return { statusCode: 200, headers, body: JSON.stringify({ free: true, reason: 'referral' }) };
      }

      await stripe.customers.create({
        email: cleanEmail, name: name || '', phone: phone || '',
        metadata: { first_time_free: 'yes', session_type: session || '', referred_by: '', claimed_at: new Date().toISOString() }
      });
      await sendNotification({ subject: `New Free Booking (First-Time) — ${session}`, name, email, phone, session, referredBy: '', type: 'Free session (first-time)', releaseSignature });
      await sendFreeBookingEmail({ email: cleanEmail, name, session, referral: false });
      return { statusCode: 200, headers, body: JSON.stringify({ free: true, reason: 'first_time' }) };
    }

    if (!amount || amount < 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid amount.' }) };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'cad',
      payment_method_types: ['card'],
      description: `MH Captures/Media — Deposit (${session || 'Session'})`,
      metadata: {
        customer_name: name || '', customer_email: email || '', session_type: session || '',
        referred_by: referredBy || '', involves_minor: involvesMinor ? 'yes' : 'no',
        minor_name: minorName || '', guardian_name: guardianName || '',
        release_signed: releaseSignature ? 'yes' : 'no',
        release_signature: releaseSignature || '',
      },
      receipt_email: email || undefined,
    });

    await sendNotification({ subject: `New Paid Booking — $30 Deposit — ${session}`, name, email, phone, session, referredBy, type: 'Paid deposit ($30)', releaseSignature });

    return { statusCode: 200, headers, body: JSON.stringify({ clientSecret: paymentIntent.client_secret }) };

  } catch (err) {
    console.error('Stripe error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
