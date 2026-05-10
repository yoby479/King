const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// SwiftWallet v3 Config
const SW_API_KEY = process.env.SW_API_KEY || 'sw_aef1d392bbf45ceec687af24b325b133ab0d561fabe3bba567630b2a';
const SW_API_URL = 'https://swiftwallet.co.ke/v3/stk-initiate/';

// Allow requests from anywhere (or set your PHP domain)
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// In-memory store for payment tracking
// Key: reference, Value: { status, loan_id, phone, amount, result, createdAt }
const payments = new Map();

// Log to console
function log(msg) {
    console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ============================================
// POST /stk-push — Initiate STK Push
// ============================================
app.post('/stk-push', async (req, res) => {
    try {
        const { loan_id, phone_number, amount, callback_url } = req.body;

        if (!loan_id || !phone_number || !amount) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: loan_id, phone_number, amount'
            });
        }

        // Format phone
        let phone = String(phone_number).replace(/[^0-9]/g, '');
        if (phone.startsWith('0') && phone.length === 10) phone = phone.substring(1);
        if (phone.length === 9 && (phone.startsWith('7') || phone.startsWith('1'))) phone = '0' + phone;

        const reference = 'ZL-' + loan_id + '-' + Date.now();

        // If callback_url not provided, use our own webhook
        const webhookUrl = callback_url || `${getBaseUrl(req)}/webhook`;

        const payload = {
            amount: parseInt(amount),
            phone_number: phone,
            external_reference: reference,
            callback_url: webhookUrl
        };

        log('STK Push request: loan=' + loan_id + ' phone=' + phone + ' amount=' + amount);

        // Call SwiftWallet v3
        const swResult = await callSwiftWallet(payload);

        if (swResult.success) {
            // Store payment
            payments.set(reference, {
                status: 'pending',
                loan_id: loan_id,
                phone: phone,
                amount: parseInt(amount),
                transaction_id: swResult.data.transaction_id || null,
                checkout_request_id: swResult.data.checkout_request_id || null,
                result: null,
                createdAt: Date.now()
            });

            log('STK Push sent successfully: ref=' + reference + ' tx=' + (swResult.data.transaction_id || 'N/A'));

            res.json({
                success: true,
                message: 'STK Push sent! Check your phone and enter your M-Pesa PIN.',
                reference: reference,
                transaction_id: swResult.data.transaction_id
            });
        } else {
            log('STK Push failed: ' + swResult.message);
            res.status(400).json({
                success: false,
                message: swResult.message
            });
        }

    } catch (err) {
        log('STK Push error: ' + err.message);
        res.status(500).json({
            success: false,
            message: 'Server error: ' + err.message
        });
    }
});

// ============================================
// GET /check/:loan_id — Check payment status
// ============================================
app.get('/check/:loan_id', (req, res) => {
    const loan_id = req.params.loan_id;

    // Find payment by loan_id
    let found = null;
    for (const [ref, payment] of payments) {
        if (payment.loan_id === loan_id) {
            found = { reference: ref, ...payment };
            break;
        }
    }

    if (!found) {
        return res.json({
            success: false,
            message: 'No payment found for this loan',
            status: 'not_found'
        });
    }

    res.json({
        success: true,
        status: found.status,
        loan_id: found.loan_id,
        amount: found.amount,
        transaction_id: found.transaction_id,
        mpesa_receipt: found.result?.MpesaReceiptNumber || null
    });
});

// ============================================
// POST /webhook — Receive SwiftWallet callback
// ============================================
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        log('Webhook received: ' + JSON.stringify(body));

        const extRef = body.external_reference || '';
        const status = body.status || 'unknown';
        const resultCode = body.result?.ResultCode ?? -1;

        // Find payment by external_reference
        let payment = null;
        for (const [ref, p] of payments) {
            if (ref === extRef) {
                payment = p;
                break;
            }
        }

        if (!payment) {
            log('Webhook: No matching payment for ref=' + extRef);
            return res.json({ status: 'received' });
        }

        if (status === 'completed' || resultCode === 0) {
            payment.status = 'approved';
            payment.result = body.result || null;
            payment.mpesa_receipt = body.result?.MpesaReceiptNumber || null;
            payment.approvedAt = Date.now();
            log('APPROVED: loan=' + payment.loan_id + ' receipt=' + payment.mpesa_receipt);

            // Forward to PHP webhook if callback_url was stored
            if (payment.php_callback_url) {
                forwardToPhp(payment);
            }
        } else {
            payment.status = 'failed';
            payment.result = body.result || null;
            payment.failedAt = Date.now();
            log('FAILED: loan=' + payment.loan_id + ' reason=' + (body.result?.ResultDesc || 'Unknown'));
        }

        res.json({ status: 'received', loan_id: payment.loan_id });

    } catch (err) {
        log('Webhook error: ' + err.message);
        res.json({ status: 'error' });
    }
});

// ============================================
// GET /health — Health check (Render needs this)
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        payments: payments.size,
        time: new Date().toISOString()
    });
});

// ============================================
// GET / — Info page
// ============================================
app.get('/', (req, res) => {
    res.json({
        service: 'ZamLoans STK Push Backend',
        version: '1.0.0',
        endpoints: {
            'POST /stk-push': 'Initiate M-Pesa STK push',
            'GET /check/:loan_id': 'Check payment status',
            'POST /webhook': 'SwiftWallet callback receiver',
            'GET /health': 'Health check'
        },
        active_payments: payments.size
    });
});

// ============================================
// Helper: Call SwiftWallet v3 API
// ============================================
function callSwiftWallet(payload) {
    return new Promise((resolve) => {
        const postData = JSON.stringify(payload);

        const options = {
            hostname: 'swiftwallet.co.ke',
            path: '/v3/stk-initiate/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + SW_API_KEY,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 30000
        };

        const req = https.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    log('SwiftWallet response: HTTP ' + response.statusCode + ' - ' + data);
                    if (response.statusCode === 200 && result.success === true) {
                        resolve({ success: true, data: result });
                    } else {
                        let msg = result.error || result.message || 'Payment failed';
                        if (response.statusCode === 401) msg = 'API key error. Contact support.';
                        if (response.statusCode === 402) msg = 'Insufficient balance. Contact support.';
                        if (response.statusCode === 429) msg = 'Rate limited. Wait and retry.';
                        resolve({ success: false, message: msg });
                    }
                } catch (e) {
                    log('SwiftWallet parse error: ' + e.message + ' data=' + data);
                    resolve({ success: false, message: 'Payment provider error. Try again.' });
                }
            });
        });

        req.on('error', (e) => {
            log('SwiftWallet request error: ' + e.message);
            resolve({ success: false, message: 'Cannot reach payment provider. Check connection.' });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, message: 'Payment provider timeout. Try again.' });
        });

        req.write(postData);
        req.end();
    });
}

// ============================================
// Helper: Forward approval to PHP server
// ============================================
function forwardToPhp(payment) {
    if (!payment.php_callback_url) return;

    const callbackData = JSON.stringify({
        success: true,
        loan_id: payment.loan_id,
        status: 'approved',
        mpesa_receipt: payment.mpesa_receipt,
        transaction_id: payment.transaction_id
    });

    const url = new URL(payment.php_callback_url);
    const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(callbackData)
        },
        timeout: 15000
    };

    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
            log('PHP callback response: HTTP ' + res.statusCode + ' - ' + body);
        });
    });

    req.on('error', (e) => {
        log('PHP callback error: ' + e.message);
    });

    req.on('timeout', () => {
        req.destroy();
        log('PHP callback timeout');
    });

    req.write(callbackData);
    req.end();
}

// ============================================
// Helper: Get base URL from request
// ============================================
function getBaseUrl(req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers['host'];
    return protocol + '://' + host;
}

// ============================================
// Clean old payments every 10 minutes (keep 1 hour)
// ============================================
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    for (const [ref, payment] of payments) {
        if (payment.createdAt < oneHourAgo) {
            payments.delete(ref);
            log('Cleaned old payment: ' + ref);
        }
    }
}, 600000);

// ============================================
// Start server
// ============================================
app.listen(PORT, () => {
    console.log('========================================');
    console.log(' ZamLoans STK Push Backend');
    console.log(' Running on port ' + PORT);
    console.log(' SwiftWallet v3 API connected');
    console.log('========================================');
});
