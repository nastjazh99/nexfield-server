/**
 * NexField Pro — Backend Server
 * Bay Area HVAC & Appliance Inc.
 * 
 * Stack: Node.js · Express · Supabase · VAPI.ai
 * Deploy: Railway.app
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());

// ─── ENV VARIABLES (set in Railway) ───────────────────────────────────────────
const {
  VAPI_API_KEY,
  VAPI_PHONE_ID,
  SUPABASE_URL,
  SUPABASE_KEY,
  WEBHOOK_SECRET,
  PORT = 3000,
  COMPANY_PHONE = '+14085505155',   // Bay Area HVAC — номер компании
  COMPANY_NAME  = 'Bay Area HVAC & Appliance Inc.',
} = process.env;

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── MIDDLEWARE: Webhook Auth ──────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn('❌ Unauthorized webhook attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── ROUTE: Health Check ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NexField Pro Server',
    company: COMPANY_NAME,
    timestamp: new Date().toISOString(),
  });
});

// ─── ROUTE: Incoming Lead Webhook ──────────────────────────────────────────────
// POST /webhook/lead
// Body: { customer_name, customer_phone, customer_address, service_type, source? }
app.post('/webhook/lead', authMiddleware, async (req, res) => {
  const {
    customer_name,
    customer_phone,
    customer_address,
    service_type,
    source = 'webhook',
  } = req.body;

  // Validate required fields
  if (!customer_name || !customer_phone) {
    return res.status(400).json({ error: 'customer_name and customer_phone are required' });
  }

  console.log(`\n📥 New Lead: ${customer_name} | ${customer_phone} | ${service_type}`);

  try {
    // 1. Save order to Supabase
    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert([{
        client_name:    customer_name,
        client_phone:   customer_phone,
        client_address: customer_address || '',
        service_type:   service_type || 'General Service',
        source,
        status:   'New',
        progress: 'Assigned',
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Supabase error:', dbError.message);
      return res.status(500).json({ error: 'Database error', details: dbError.message });
    }

    console.log(`✅ Order saved: #${order.id}`);

    // 2. Trigger VAPI AI call
    const callResult = await triggerVapiCall({
      orderId:      order.id,
      clientName:   customer_name,
      clientPhone:  customer_phone,
      clientAddress: customer_address,
      serviceType:  service_type,
    });

    // 3. Update order with VAPI call ID
    if (callResult.callId) {
      await supabase
        .from('orders')
        .update({ vapi_call_id: callResult.callId })
        .eq('id', order.id);
    }

    res.json({
      success:  true,
      order_id: order.id,
      call_id:  callResult.callId || null,
      message:  'Lead received, order created, AI call triggered',
    });

  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ─── ROUTE: VAPI Call Webhook (post-call summary) ─────────────────────────────
// POST /webhook/vapi
// VAPI sends this after the call ends with transcript + summary
app.post('/webhook/vapi', async (req, res) => {
  const { call } = req.body;

  if (!call) return res.status(400).json({ error: 'No call data' });

  const callId     = call.id;
  const transcript = call.artifact?.transcript || '';
  const summary    = call.artifact?.summary    || call.analysis?.summary || '';
  const status     = call.status === 'ended' ? 'completed' : call.status;

  console.log(`\n📞 VAPI callback: call ${callId} | status: ${status}`);

  try {
    const { error } = await supabase
      .from('orders')
      .update({
        call_transcript: transcript,
        call_summary:    summary,
        call_completed:  status === 'completed',
      })
      .eq('vapi_call_id', callId);

    if (error) {
      console.error('❌ VAPI update error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log(`✅ Call summary saved for call ${callId}`);
    res.json({ success: true });

  } catch (err) {
    console.error('❌ VAPI webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ROUTE: Manual Order (from app or admin) ──────────────────────────────────
// POST /orders/create
app.post('/orders/create', authMiddleware, async (req, res) => {
  const { client_name, client_phone, client_address, service_type } = req.body;

  if (!client_name || !client_phone) {
    return res.status(400).json({ error: 'client_name and client_phone required' });
  }

  const { data, error } = await supabase
    .from('orders')
    .insert([{
      client_name,
      client_phone,
      client_address: client_address || '',
      service_type:   service_type   || 'General Service',
      source:   'manual',
      status:   'New',
      progress: 'Assigned',
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, order: data });
});

// ─── ROUTE: Get All Orders ─────────────────────────────────────────────────────
// GET /orders
app.get('/orders', authMiddleware, async (req, res) => {
  const { status, limit = 50 } = req.query;

  let query = supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Number(limit));

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ orders: data, count: data.length });
});

// ─── ROUTE: Update Order Status ───────────────────────────────────────────────
// PATCH /orders/:id
app.patch('/orders/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const updates = req.body; // e.g. { status: 'Completed', progress: 'Completed' }

  const { data, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, order: data });
});

// ─── HELPER: Trigger VAPI AI Call ─────────────────────────────────────────────
async function triggerVapiCall({ orderId, clientName, clientPhone, clientAddress, serviceType }) {
  if (!VAPI_API_KEY || !VAPI_PHONE_ID) {
    console.warn('⚠️ VAPI not configured — skipping call');
    return { callId: null };
  }

  const systemPrompt = `You are a friendly scheduling assistant for ${COMPANY_NAME}.
A customer named ${clientName} just requested ${serviceType || 'appliance repair'} service.
Your goal:
1. Confirm their service request
2. Ask about the best time for a technician visit (morning/afternoon/specific day)
3. Confirm their address: ${clientAddress || 'not provided — please ask'}
4. Be warm, professional, and brief (under 2 minutes)
5. End the call by telling them a technician will call to confirm the exact time.
Order reference: #${orderId}`;

  try {
    const response = await axios.post(
      'https://api.vapi.ai/call/phone',
      {
        phoneNumberId: VAPI_PHONE_ID,
        customer: {
          number: clientPhone,
          name:   clientName,
        },
        assistant: {
          model: {
            provider: 'openai',
            model:    'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }],
          },
          voice: {
            provider: 'playht',
            voiceId:  'jennifer',
          },
          firstMessage: `Hi ${clientName.split(' ')[0]}! This is an automated call from ${COMPANY_NAME}. I'm calling about your service request. Is this a good time to speak?`,
          endCallMessage: 'Thank you! Our technician will be in touch shortly. Have a great day!',
          maxDurationSeconds: 180,
        },
        serverUrl: process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/vapi`
          : undefined,
      },
      {
        headers: {
          Authorization: `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const callId = response.data?.id;
    console.log(`📞 VAPI call initiated: ${callId}`);
    return { callId };

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('❌ VAPI call failed:', msg);
    return { callId: null, error: msg };
  }
}

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 NexField Pro Server running on port ${PORT}`);
  console.log(`   Company: ${COMPANY_NAME}`);
  console.log(`   Supabase: ${SUPABASE_URL ? '✅ connected' : '❌ not configured'}`);
  console.log(`   VAPI:     ${VAPI_API_KEY ? '✅ configured' : '❌ not configured'}\n`);
});

module.exports = app;
