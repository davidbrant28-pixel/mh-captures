const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
    const { amount, session, name, email, referredBy, involvesMinor, minorName, guardianName, isFirstTime } = JSON.parse(event.body);

    // ── FIRST TIME CLIENT CHECK ──
    if (isFirstTime) {
      if (!email || !email.includes('@')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required to claim your free session.' }) };
      }

      // Search Stripe for any existing customer with this email
      const existing = await stripe.customers.list({ email: email.toLowerCase().trim(), limit: 1 });

      if (existing.data.length > 0) {
        // Check if they have any previous payments
        const charges = await stripe.charges.list({ customer: existing.data[0].id, limit: 1 });
        if (charges.data.length > 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'This email has already been used for a session. The first-time offer is for new clients only.' })
          };
        }
      }

      // Valid first-time — create customer record to prevent reuse
      await stripe.customers.create({
        email: email.toLowerCase().trim(),
        name: name || '',
        metadata: {
          session_type: session || '',
          first_time_free: 'yes',
          referred_by: referredBy || '',
        }
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ firstTimeFree: true, message: 'Free session confirmed.' })
      };
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
        customer_name: name || '',
        customer_email: email || '',
        session_type: session || '',
        referred_by: referredBy || '',
        involves_minor: involvesMinor ? 'yes' : 'no',
        minor_name: minorName || '',
        guardian_name: guardianName || '',
      },
      receipt_email: email || undefined,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ clientSecret: paymentIntent.client_secret }),
    };

  } catch (err) {
    console.error('Stripe error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
