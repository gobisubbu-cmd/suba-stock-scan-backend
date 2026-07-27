const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'SUBA Stock Alerts <onboarding@resend.dev>';
const CRON_SECRET = process.env.CRON_SECRET;

const { runPutawayReminder } = require('./putaway-reminder');

const EXTRACTION_PROMPT = `You are looking at a photo or PDF of a stock/inventory document. This could be a
handwritten stock register page, a printed stock ledger, a supplier invoice, a delivery
challan, or a spare-parts price list.

Extract every distinct stock item/line you can find and return ONLY a JSON array (no markdown
fences, no commentary, no explanation) where each element has this exact shape:

{
  "particulars": string,       // item name / description, required
  "unit": string | null,       // e.g. "Nos", "Kg", "Mtr" - null if not shown
  "quantity": number | null,   // stock / opening quantity if shown, else null
  "rackNo": string | null,     // rack / bin / location code if shown
  "hsnCode": string | null,    // HSN/SAC code if shown
  "avgCost": number | null,    // unit cost / rate if shown
  "reorderLevel": number | null // reorder / minimum level if shown
}

Rules:
- If a field is not present in the document, use null - do not guess or invent values.
- Only include rows that clearly represent a stock item; skip headers, totals, and signatures.
- Numbers must be plain numbers (no currency symbols, no commas).
- Return valid JSON only. The entire response must be parseable with JSON.parse.`;

function stripCodeFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  }
  return t;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, hasKey: Boolean(ANTHROPIC_API_KEY), hasEmailKey: Boolean(RESEND_API_KEY) });
});

app.post('/api/send-email', async (req, res) => {
  try {
    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: 'Server is missing RESEND_API_KEY. Set it in Render environment variables.' });
    }
    const { to, subject, text, html } = req.body || {};
    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({ error: 'to, subject, and text or html are required.' });
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: ALERT_FROM_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject,
        text: text || undefined,
        html: html || undefined,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      const message = data?.message || 'Email send failed.';
      return res.status(response.status).json({ error: message });
    }

    return res.json({ ok: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

app.post('/api/extract', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in Render environment variables.' });
    }
    const { mimeType, base64Data } = req.body || {};
    if (!mimeType || !base64Data) {
      return res.status(400).json({ error: 'mimeType and base64Data are required.' });
    }

    const isPdf = mimeType === 'application/pdf';
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } };

    const headers = {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (isPdf) {
      headers['anthropic-beta'] = 'pdfs-2024-09-25';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || 'AI extraction request failed.';
      return res.status(response.status).json({ error: message });
    }

    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No text returned from AI model.' });
    }

    let items;
    try {
      items = JSON.parse(stripCodeFences(textBlock.text));
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse AI response as JSON.', raw: textBlock.text });
    }

    if (!Array.isArray(items)) {
      return res.status(502).json({ error: 'AI response was not a JSON array.', raw: textBlock.text });
    }

    return res.json({ items });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

app.post('/api/putaway-reminder', async (req, res) => {
  try {
    if (!CRON_SECRET) {
      return res.status(500).json({ error: 'Server is missing CRON_SECRET. Set it in Render environment variables.' });
    }
    if (req.get('x-cron-secret') !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized.' });
    }
    const result = await runPutawayReminder({ RESEND_API_KEY, ALERT_FROM_EMAIL });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SUBA stock-scan backend listening on port ${PORT}`);
});
