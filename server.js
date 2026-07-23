const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const DARAJA_CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY || 'YOUR_CONSUMER_KEY';
const DARAJA_CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET || 'YOUR_CONSUMER_SECRET';
const SHORTCODE = process.env.SHORTCODE || '174379';
const PASSKEY = process.env.PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const CALLBACK_URL = 'https://lalapoa-app.up.railway.app/api/mpesa/callback';

const reservationsDB = [];
const transactionsDB = [];

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry - 300000) {
        return cachedToken;
    }
    
    const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        cachedToken = response.data.access_token;
        tokenExpiry = now + 3600000;
        return cachedToken;
    } catch (error) {
        console.error('Error generating token:', error.response?.data || error.message);
        throw new Error('Failed to authenticate with M-Pesa API');
    }
}

app.post('/api/bookings/checkout', async (req, res) => {
    try {
        const { phoneNumber, amount, propertyId, guestName, bookingRef } = req.body;
        
        let formattedPhone = phoneNumber.toString().trim();
        if (formattedPhone.startsWith('+')) formattedPhone = formattedPhone.slice(1);
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);

        const token = await getAccessToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

        const payload = {
            BusinessShortCode: SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: formattedPhone,
            PartyB: SHORTCODE,
            PhoneNumber: formattedPhone,
            CallBackURL: CALLBACK_URL,
            AccountReference: bookingRef,
            TransactionDesc: `Stay payment for ${propertyId}`
        };

        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            payload,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        reservationsDB.push({
            bookingRef,
            propertyId,
            guestName,
            phoneNumber: formattedPhone,
            amount,
            checkoutRequestID: response.data.CheckoutRequestID,
            status: 'PENDING'
        });

        return res.status(200).json({
            success: true,
            message: 'STK push sent to customer phone successfully.',
            checkoutRequestID: response.data.CheckoutRequestID
        });

    } catch (error) {
        console.error('STK Push Error:', error.response?.data || error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mpesa/callback', async (req, res) => {
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

    try {
        const body = req.body.Body?.stkCallback;
        if (!body) return;

        const checkoutRequestID = body.CheckoutRequestID;
        const resultCode = body.ResultCode;

        const reservation = reservationsDB.find(r => r.checkoutRequestID === checkoutRequestID);
        if (!reservation) return;

        if (resultCode === 0) {
            const callbackItems = body.CallbackMetadata.Item;
            const mpesaReceiptNumber = callbackItems.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
            const transactionDate = callbackItems.find(i => i.Name === 'TransactionDate')?.Value;

            reservation.status = 'PAID';
            reservation.mpesaReceiptNumber = mpesaReceiptNumber;

            transactionsDB.push({
                bookingRef: reservation.bookingRef,
                mpesaReceiptNumber,
                amount: reservation.amount,
                phone: reservation.phoneNumber,
                timestamp: transactionDate
            });

            console.log(`Payment confirmed for Booking: ${reservation.bookingRef}, Receipt: ${mpesaReceiptNumber}`);
            await sendGuestConfirmationSMS(reservation.phoneNumber, reservation.guestName, reservation.bookingRef);

        } else {
            reservation.status = 'FAILED';
            console.log(`Payment failed or cancelled for Booking: ${reservation.bookingRef}. Reason: ${body.ResultDesc}`);
        }

    } catch (err) {
        console.error('Error handling callback payload:', err);
    }
});

async function sendGuestConfirmationSMS(phone, name, bookingRef) {
    const message = `Hello ${name}, payment received successfully! Your Lalapoa booking reference ${bookingRef} is confirmed. Check-in details will be sent shortly. Thank you!`;
    console.log(`[OUTBOUND SMS to ${phone}]: ${message}`);
}

app.listen(PORT, () => {
    console.log(`Lalapoa backend engine running live on port ${PORT}`);
}); add server.js
