# ZamLoans STK Push Backend

Node.js backend for SwiftWallet v3 STK push. Deploys on **Render Free Tier**.

## Deploy on Render (Free)

### Option 1: One-Click Deploy
1. Push this folder to a GitHub repo
2. Go to https://dashboard.render.com
3. Click **"New"** → **"Web Service"**
4. Connect your GitHub repo
5. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
6. Add environment variable:
   - Key: `SW_API_KEY` = `sw_aef1d392bbf45ceec687af24b325b133ab0d561fabe3bba567630b2a`
7. Click **"Create Web Service"**
8. Wait for deploy (takes 2-3 minutes)
9. Copy your URL (e.g. `https://zamloans-backend-xxxx.onrender.com`)

### Option 2: render.yaml
1. Push this folder to GitHub
2. Go to https://dashboard.render.com
3. Click **"New"** → **"Blueprint"**
4. Connect your GitHub repo (must have `render.yaml`)
5. Click **"Apply"**

## After Deployment

1. Open your Render URL in browser - you should see:
   ```json
   {"service":"ZamLoans STK Push Backend","version":"1.0.0",...}
   ```

2. Test health: `https://YOUR-APP.onrender.com/health`

3. **Update your ZamLoans PHP `config.php`:**
   Change:
   ```php
   $RENDER_BACKEND = 'https://YOUR-APP.onrender.com';
   ```
   Replace `YOUR-APP.onrender.com` with your actual Render URL.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| GET | `/health` | Health check |
| POST | `/stk-push` | Initiate STK push |
| GET | `/check/:loan_id` | Check payment status |
| POST | `/webhook` | SwiftWallet callback |

### POST /stk-push
```json
{
  "loan_id": "ZLABC12345",
  "phone_number": "795314221",
  "amount": 200,
  "callback_url": "https://your-php-site.com/api/webhook.php?loan_id=ZLABC12345"
}
```

### GET /check/:loan_id
Returns:
```json
{
  "success": true,
  "status": "approved",
  "mpesa_receipt": "SAE3YULR0Y"
}
```

## Important Notes

- Render free tier services **sleep after 15 minutes** of inactivity
- First request after sleep takes ~30 seconds to wake up
- The backend uses **in-memory storage** — payments are lost on restart
- For production, add a database (Redis, PostgreSQL)
