/**
 * NexField Pro — Backend Server
 * Bay Area HVAC & Appliance Inc.
 * Stack: Node.js · Express · Supabase · VAPI.ai · Web Push
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const webpush = require('web-push');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const {
  VAPI_API_KEY, VAPI_PHONE_ID,
  SUPABASE_URL, SUPABASE_KEY,
  WEBHOOK_SECRET,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
  VAPID_EMAIL = 'mailto:edgar@bayareahvac.com',
  PORT = 3000,
  COMPANY_NAME = 'Bay Area HVAC & Appliance Inc.',
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('✅ Web Push configured');
}

let pushSubscriptions = [];

function authMiddleware(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NexField Pro Server', company: COMPANY_NAME, push_enabled: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), subscriptions: pushSubscriptions.length, timestamp: new Date().toISOString() });
});

app.get('/push/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

app.post('/push/subscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const exists = pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    pushSubscriptions.push(subscription);
    console.log(`📱 New push subscription. Total: ${pushSubscriptions.length}`);
  }
  res.json({ success: true, total: pushSubscriptions.length });
});

async function sendPush(title, body, data = {}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || pushSubscriptions.length === 0) return;
  const payload = JSON.stringify({ title, body, data });
  const failed = [];
  for (const sub of pushSubscriptions) {
    try { await webpush.sendNotification(sub, payload); }
    catch (err) { if (err.statusCode === 410 || err.statusCode === 404) failed.push(sub.endpoint); }
  }
  if (failed.length > 0) pushSubscriptions = pushSubscriptions.filter(s => !failed.includes(s.endpoint));
}

app.post('/webhook/lead', authMiddleware, async (req, res) => {
  const { customer_name, customer_phone, customer_address, service_type, source = 'webhook' } = req.body;
  if (!customer_name || !customer_phone) return res.status(400).json({ error: 'customer_name and customer_phone are required' });

  try {
    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert([{ client_name: customer_name, client_phone: customer_phone, client_address: customer_address || '', service_type: service_type || 'General Service', source, status: 'New', progress: 'Assigned' }])
      .select().single();

    if (dbError) return res.status(500).json({ error: 'Database error', details: dbError.message });

    await sendPush('🔔 New Lead!', `${customer_name} · ${service_type || 'Service'} · ${customer_phone}`, { order_id: order.id, type: 'new_lead' });

    const callResult = await triggerVapiCall({ orderId: order.id, clientName: customer_name, clientPhone: customer_phone, clientAddress: customer_address, serviceType: service_type });

    if (callResult.callId) await supabase.from('orders').update({ vapi_call_id: callResult.callId }).eq('id', order.id);

    res.json({ success: true, order_id: order.id, call_id: callResult.callId || null, message: 'Lead received, order created, AI call triggered' });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

app.post('/webhook/vapi', async (req, res) => {
  const { call } = req.body;
  if (!call) return res.status(400).json({ error: 'No call data' });
  const callId = call.id;
  const transcript = call.artifact?.transcript || '';
  const summary = call.artifact?.summary || call.analysis?.summary || '';
  const completed = call.status === 'ended';
  try {
    const { error } = await supabase.from('orders').update({ call_transcript: transcript, call_summary: summary, call_completed: completed }).eq('vapi_call_id', callId);
    if (error) return res.status(500).json({ error: error.message });
    if (completed && summary) await sendPush('🤖 AI Call Done', `${summary.substring(0, 80)}...`, { type: 'call_completed' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/orders', authMiddleware, async (req, res) => {
  const { status, limit = 50 } = req.query;
  let query = supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(Number(limit));
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data, count: data.length });
});

app.patch('/orders/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('orders').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, order: data });
});

async function triggerVapiCall({ orderId, clientName, clientPhone, clientAddress, serviceType }) {
  if (!VAPI_API_KEY || !VAPI_PHONE_ID) return { callId: null };
  const systemPrompt = `You are a friendly scheduling assistant for ${COMPANY_NAME}. A customer named ${clientName} just requested ${serviceType || 'appliance repair'} service. 1. Confirm their request. 2. Ask best time for a visit. 3. Confirm address: ${clientAddress || 'not provided'}. 4. Be brief under 2 minutes. 5. End by saying technician will call to confirm. Order #${orderId}`;
  try {
    const response = await axios.post('https://api.vapi.ai/call/phone', {
      phoneNumberId: VAPI_PHONE_ID,
      customer: { number: clientPhone, name: clientName },
      assistant: { model: { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'system', content: systemPrompt }] }, voice: { provider: 'playht', voiceId: 'jennifer' }, firstMessage: `Hi ${clientName.split(' ')[0]}! This is ${COMPANY_NAME} calling about your service request. Is this a good time?`, endCallMessage: 'Thank you! Our technician will be in touch. Have a great day!', maxDurationSeconds: 180 },
    }, { headers: { Authorization: `Bearer ${VAPI_API_KEY}`, 'Content-Type': 'application/json' } });
    return { callId: response.data?.id };
  } catch (err) {
    console.error('VAPI error:', err.response?.data?.message || err.message);
    return { callId: null };
  }
}

app.listen(PORT, () => console.log(`🚀 NexField Pro running on port ${PORT}`));
