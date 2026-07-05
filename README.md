# MH Captures/Media — Website

Photography booking website with Stripe payments.

---

## 🚀 Deploy to Netlify (Step-by-Step)

### Step 1 — Upload to GitHub
1. Go to [github.com](https://github.com) and sign in (or create a free account)
2. Click **New repository** → name it `mh-captures`
3. Upload all these files by dragging the folder contents in

### Step 2 — Deploy on Netlify
1. Go to [netlify.com](https://netlify.com) and sign in with GitHub
2. Click **Add new site → Import an existing project**
3. Choose **GitHub** → select your `mh-captures` repo
4. Build settings will auto-detect from `netlify.toml` — just click **Deploy**

### Step 3 — Add your Stripe Secret Key
1. In Netlify, go to **Site Settings → Environment Variables**
2. Click **Add a variable**
3. Key: `STRIPE_SECRET_KEY`
4. Value: your Stripe secret key (starts with `sk_live_...`)
   - Find it at: stripe.com → Developers → API Keys
5. Click **Save** then **Trigger deploy** to rebuild

### Step 4 — You're live! 🎉
Netlify gives you a free URL like `mh-captures.netlify.app`
You can also connect a custom domain in Site Settings → Domain Management.

---

## 💳 How Payments Work
- Customer fills booking form → selects package → sees deposit amount
- Clicks "Pay deposit" → Stripe card form processes the payment
- Apple Pay / Google Pay shown automatically on supported devices
- Payment goes directly to your Stripe account
- Customer sees success confirmation

## 🔑 Environment Variables Needed
| Variable | Where to find it |
|---|---|
| `STRIPE_SECRET_KEY` | stripe.com → Developers → API Keys → Secret key |

## 📁 File Structure
```
mh-captures/
├── public/
│   └── index.html        ← Your website
├── api/
│   └── create-payment-intent.js  ← Stripe backend function
├── netlify.toml          ← Netlify config
├── package.json          ← Dependencies
└── README.md             ← This file
```
