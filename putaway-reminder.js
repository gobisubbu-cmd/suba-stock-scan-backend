// Daily "Warehouse Put-away Pending Report" reminder.
// Triggered by a scheduled GitHub Actions workflow hitting POST /api/putaway-reminder
// with header x-cron-secret matching process.env.CRON_SECRET.
//
// - Reads all putawayLines with status != COMPLETE from Firestore (via firebase-admin,
//   using a service-account key set in FIREBASE_SERVICE_ACCOUNT env var).
// - If there are none, sends nothing.
// - Otherwise builds Pending_Location_Report.xlsx (Invoice Number, Invoice Date, Supplier,
//   Item Code, Description, Received Qty, Located Qty, Pending Qty, Days Pending, Status)
//   and emails it via Resend to the Administrator, CC'ing Stores Manager / General Manager /
//   Managing Director once any line's days-pending crosses 3 / 7 / 15 days respectively.

const XLSX = require('xlsx');

let admin;
function getAdmin() {
  if (admin) return admin;
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error('Server is missing FIREBASE_SERVICE_ACCOUNT. Set it in Render environment variables.');
    }
    let json = raw.trim();
    // Allow either raw JSON or base64-encoded JSON in the env var.
    if (!json.startsWith('{')) {
      json = Buffer.from(json, 'base64').toString('utf8');
    }
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin;
}

function daysPending(createdAt) {
  if (!createdAt) return 0;
  const d = typeof createdAt.toDate === 'function' ? createdAt.toDate() : new Date(createdAt);
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function buildReportWorkbook(rows) {
  const sheetRows = rows.map((r) => ({
    'Invoice Number': r.invoiceNumber || '',
    'Invoice Date': r.invoiceDate || '',
    Supplier: r.supplier || '',
    'Item Code': r.itemCode ?? '',
    Description: r.description || '',
    'Received Qty': r.receivedQty || 0,
    'Located Qty': r.locatedQty || 0,
    'Pending Qty': r.pendingQty || 0,
    'Days Pending': r.daysPending,
    Status: r.status,
  }));
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  ws['!cols'] = [
    { wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 12 }, { wch: 30 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 16 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pending Location Report');
  return wb;
}

function buildEmailBody({ pendingInvoices, pendingItems, pendingQty, oldestDays }) {
  return [
    'Dear Admin,',
    '',
    'The following warehouse put-away activities are still pending.',
    '',
    `Pending Purchase Invoices : ${pendingInvoices}`,
    `Pending Items : ${pendingItems}`,
    `Pending Quantity : ${pendingQty}`,
    `Oldest Pending : ${oldestDays} Days`,
    '',
    'Please update the warehouse locations immediately.',
    'The detailed Pending Location Report is attached.',
    '',
    'Regards,',
    'SUBA Inventory Management System',
  ].join('\n');
}

async function runPutawayReminder({ RESEND_API_KEY, ALERT_FROM_EMAIL }) {
  const fb = getAdmin();
  const db = fb.firestore();

  const snap = await db.collection('putawayLines').where('status', '!=', 'COMPLETE').get();
  const rows = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      daysPending: daysPending(data.createdAt),
    };
  });

  if (rows.length === 0) {
    return { sent: false, reason: 'No pending put-away lines.', pendingItems: 0 };
  }

  const settingsSnap = await db.collection('settings').doc('general').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const adminEmail = settings.lowStockAlertEmail;
  if (!adminEmail) {
    throw new Error('No Administrator alert email configured in Settings.');
  }

  const invoiceSet = new Set(rows.map((r) => r.invoiceNumber || r.id));
  const pendingQty = rows.reduce((s, r) => s + Number(r.pendingQty || 0), 0);
  const daysList = rows.map((r) => r.daysPending);
  const oldestDays = Math.max(...daysList);

  const cc = [];
  if (oldestDays > 3 && settings.storesManagerEmail) cc.push(settings.storesManagerEmail);
  if (oldestDays > 7 && settings.generalManagerEmail) cc.push(settings.generalManagerEmail);
  if (oldestDays > 15 && settings.managingDirectorEmail) cc.push(settings.managingDirectorEmail);
  // Dedupe (all three may currently point at the same address).
  const ccUnique = [...new Set(cc)].filter((e) => e && e !== adminEmail);

  const wb = buildReportWorkbook(rows);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const subject = 'Warehouse Put-away Pending Report';
  const text = buildEmailBody({
    pendingInvoices: invoiceSet.size,
    pendingItems: rows.length,
    pendingQty,
    oldestDays,
  });

  if (!RESEND_API_KEY) {
    throw new Error('Server is missing RESEND_API_KEY. Set it in Render environment variables.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL,
      to: [adminEmail],
      cc: ccUnique.length ? ccUnique : undefined,
      subject,
      text,
      attachments: [
        {
          filename: 'Pending_Location_Report.xlsx',
          content: buf.toString('base64'),
        },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || 'Email send failed.');
  }

  return {
    sent: true,
    id: data.id,
    to: adminEmail,
    cc: ccUnique,
    pendingInvoices: invoiceSet.size,
    pendingItems: rows.length,
    pendingQty,
    oldestDays,
  };
}

module.exports = { runPutawayReminder };
