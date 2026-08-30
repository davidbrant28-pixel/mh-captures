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

    // FIRST TIME CLIENT CHECK
    if (isFirstTime) {
      if (!email || !email.includes('@')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email is required to claim your free session.' }) };
      }

      const cleanEmail = email.toLowerCase().trim();
      const existing = await stripe.customers.list({ email: cleanEmail, limit: 10 });

      if (existing.data.length > 0) {
        for (const customer of existing.data) {

          // CHECK 1: already claimed free session
          if (customer.metadata && customer.metadata.first_time_free === 'yes') {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'This email has already claimed a free session. This offer is for new clients only.' })
            };
          }

          // CHECK 2: has previous charges
          const charges = await stripe.charges.list({ customer: customer.id, limit: 1 });
          if (charges.data.length > 0) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'This email has already been used for a paid session.' })
            };
          }

        }
      }

      // Valid first-time client — record them
      await stripe.customers.create({
        email: cleanEmail,
        name: name || '',
        metadata: {
          first_time_free: 'yes',
          session_type: session || '',
          referred_by: referredBy || '',
          claimed_at: new Date().toISOString(),
        }
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ firstTimeFree: true, message: 'Free session confirmed.' })
      };
    }

    // REGULAR PAYMENT
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
