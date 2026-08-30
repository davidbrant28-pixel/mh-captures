const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

// Send email notification via Formspree from server side
function sendNotification(data) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      _subject: data.subject,
      name: data.name,
      email: data.email,
      phone: data.phone || 'Not provided',
      session: data.session,
      booking_type: data.type,
      referred_by: data.referredBy || 'None',
      message: `New booking:\n\nName: ${data.name}\nEmail: ${data.email}\nPhone: ${data.phone || 'Not provided'}\nSession: ${data.session}\nType: ${data.type}\nReferred by: ${data.referredBy || 'None'}`,
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

    const req = https.request(options, (res) => {
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
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
    const { amount, session, name, email, phone, referredBy, involvesMinor, minorName, guardianName, checkFreeEligibility } = JSON.parse(event.body);

    // ── FREE SESSION ELIGIBILITY CHECK ──
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

        const match = allCustomers.data.find(c =>
          c.name && c.name.toLowerCase().includes(referralName)
        );

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

        // Send notification from server
        await sendNotification({
          subject: `New Free Booking (Referral) — ${session}`,
          name, email, phone, session, referredBy,
          type: 'Free session (referral)',
        });

        return { statusCode: 200, headers, body: JSON.stringify({ free: true, reason: 'referral' }) };
      }

      await stripe.customers.create({
        email: cleanEmail, name: name || '', phone: phone || '',
        metadata: { first_time_free: 'yes', session_type: session || '', referred_by: '', claimed_at: new Date().toISOString() }
      });

      // Send notification from server
      await sendNotification({
        subject: `New Free Booking (First-Time) — ${session}`,
        name, email, phone, session, referredBy: '',
        type: 'Free session (first-time)',
      });

      return { statusCode: 200, headers, body: JSON.stringify({ free: true, reason: 'first_time' }) };
    }

    // ── REGULAR PAYMENT ──
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
      },
      receipt_email: email || undefined,
    });

    // Send notification from server for paid bookings
    await sendNotification({
      subject: `New Paid Booking — $30 Deposit — ${session}`,
      name, email, phone, session, referredBy,
      type: 'Paid deposit ($30)',
    });

    return { statusCode: 200, headers, body: JSON.stringify({ clientSecret: paymentIntent.client_secret }) };

  } catch (err) {
    console.error('Stripe error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
