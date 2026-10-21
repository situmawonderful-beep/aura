/* ==========================================================================
   AURA — app.js / storage.js / subscription.js  (combined, vanilla JS)
   Backed by Firebase: Firestore holds businesses + appointments, Firebase
   Auth handles login for the platform admin and business owners.
   ========================================================================== */

/* ---------------------------------------------------------------------
   1. FIREBASE INIT
   --------------------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyBY0LErefE0zm5Px4KrROFCvovnlbtOG-o",
  authDomain: "fno-aff64.firebaseapp.com",
  projectId: "fno-aff64",
  storageBucket: "fno-aff64.firebasestorage.app",
  messagingSenderId: "407042475311",
  appId: "1:407042475311:web:a0ddbd68ad4a866ff54dda",
  measurementId: "G-06DQKHYCWP"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// The one Firebase Auth UID that is allowed to act as platform admin.
// Set this to the UID of the admin account you created in the Firebase console.
const ADMIN_UID = 'wjEPvG3otdTYej6dbyZ51yazS5G2';

/* ---------------------------------------------------------------------
   2. FIRESTORE-BACKED BUSINESS CACHE
   The rest of the app calls getBusinesses()/getBusiness() synchronously,
   exactly like the old localStorage version did. Under the hood, this
   cache is kept in sync with Firestore in real time via onSnapshot, so
   data now persists on the server and updates across every device/tab
   automatically — nothing downstream had to change to get that.
   --------------------------------------------------------------------- */
let businessCache = [];
let cacheReady = false;
const cacheReadyWaiters = [];

function whenCacheReady(cb){
  if(cacheReady) cb(); else cacheReadyWaiters.push(cb);
}

function getBusinesses(){ return businessCache; }
/* A suspended business is hidden from the public, cannot take bookings, and sees a notice in its dashboard. */
function isSuspended(b){ return !!(b && b.subscription && b.subscription.status === 'suspended'); }
function getPublicBusinesses(){ return businessCache.filter(b => !isSuspended(b)); }
function getBusiness(id){ return businessCache.find(b => b.id === id); }

function saveBusiness(updated){
  // Optimistic local update so the UI feels instant; Firestore write happens
  // in the background and the onSnapshot listener reconciles afterwards.
  const idx = businessCache.findIndex(b => b.id === updated.id);
  if(idx > -1) businessCache[idx] = updated;
  const { appointments, busy, ...toSave } = updated; // appointments + busy slots live in their own subcollections
  db.collection('businesses').doc(updated.id).set(toSave)
    .catch(err => {
      console.error('Failed to save business', err);
      const tooBig = err && (err.code === 'invalid-argument' || /exceeds the maximum|too large/i.test(err.message || ''));
      showToast(tooBig ? 'Could not save — too much photo data. Remove or shrink some photos.' : 'Could not save — check your internet connection', 'error');
    });
}

function startBusinessListener(){
  db.collection('businesses').onSnapshot(snapshot => {
    businessCache = snapshot.docs.map(doc => {
      const existing = businessCache.find(b => b.id === doc.id);
      return { appointments: existing ? existing.appointments : [], busy: existing ? existing.busy : [], ...doc.data(), id: doc.id };
    });
    cacheReady = true;
    cacheReadyWaiters.splice(0).forEach(cb => cb());
    refreshRoute();
  }, err => {
    console.error('Firestore listener error', err);
    showToast('Could not load businesses — check your internet connection', 'error');
  });
}

/* ---------------------------------------------------------------------
   3. APPOINTMENTS (Firestore subcollection: businesses/{id}/appointments)
   A subcollection — rather than an array field on the business doc — is
   what lets the security rules allow a stranger to CREATE a booking
   without being able to read, edit or delete anyone else's data.
   --------------------------------------------------------------------- */
const appointmentListeners = {};
function ensureAppointmentsListener(bizId){
  if(appointmentListeners[bizId]) return;
  appointmentListeners[bizId] = db.collection('businesses').doc(bizId).collection('appointments')
    .onSnapshot(snap => {
      const biz = getBusiness(bizId);
      if(!biz) return;
      biz.appointments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      loadedFlags[bizId + ':appts'] = true;
      maybeBackfillBusy(bizId);
      refreshRoute();
    }, err => console.error('Appointments listener error', err));
}

/* Privacy design: customer details (name, phone, email) live ONLY in appointments, which only the
   business owner and the admin can read. The public booking page reads businesses/{id}/busy instead:
   one tiny document per taken slot holding just { date, time, apptId }. The slot document's id is
   "YYYY-MM-DD_HH:MM", so a slot can only ever be taken once (double-booking is impossible). */
const busyListeners = {}, loadedFlags = {}, busyBackfilled = {};
function ensureBusyListener(bizId){
  if(busyListeners[bizId]) return;
  busyListeners[bizId] = db.collection('businesses').doc(bizId).collection('busy')
    .onSnapshot(snap => {
      const biz = getBusiness(bizId);
      if(!biz) return;
      biz.busy = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      loadedFlags[bizId + ':busy'] = true;
      maybeBackfillBusy(bizId);
      refreshRoute();
    }, err => console.error('Busy-slot listener error', err));
}

/* Bookings made before this update have no slot document. The first time the owner (or admin) opens
   their dashboard, create the missing ones so those times stay blocked for the public. */
function maybeBackfillBusy(bizId){
  if(busyBackfilled[bizId] || !loadedFlags[bizId + ':busy'] || !loadedFlags[bizId + ':appts']) return;
  const biz = getBusiness(bizId), u = auth.currentUser;
  if(!biz || !u || (biz.ownerUid !== u.uid && u.uid !== ADMIN_UID)) return;
  busyBackfilled[bizId] = true;
  const have = new Set((biz.busy || []).map(b => b.id));
  const today = localISO();
  const batch = db.batch(); let n = 0;
  (biz.appointments || []).forEach(a => {
    if(a.status === 'cancelled' || a.status === 'completed' || a.date < today) return;
    const id = a.date + '_' + a.time;
    if(have.has(id)) return;
    have.add(id);
    batch.set(db.collection('businesses').doc(bizId).collection('busy').doc(id), { date: a.date, time: a.time, apptId: a.id });
    n++;
  });
  if(n) batch.commit().catch(e => console.error('Slot backfill failed', e));
}

function addAppointment(bizId, appt){
  const bizRef = db.collection('businesses').doc(bizId);
  const apptRef = bizRef.collection('appointments').doc();
  const slotRef = bizRef.collection('busy').doc(appt.date + '_' + appt.time);
  const batch = db.batch();
  batch.set(apptRef, appt);
  batch.set(slotRef, { date: appt.date, time: appt.time, apptId: apptRef.id });
  return batch.commit(); // fails as a whole if somebody already took this slot
}
/* Automatic emails via EmailJS (free: 200/month, no server). Leave publicKey empty to switch emails off.
   One generic template is used for every email: {{subject}}, {{message}}, {{to_name}} and "To email" = {{to_email}}. */
const EMAILJS = { publicKey:'j5sZoepLpCmnBv3n8', serviceId:'service_zuzxas7', templateId:'template_qio4h39' };
function sendEmail(toEmail, toName, subject, message){
  if(!EMAILJS.publicKey || !EMAILJS.serviceId || !EMAILJS.templateId || !toEmail) return Promise.resolve(false);
  return fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ service_id:EMAILJS.serviceId, template_id:EMAILJS.templateId, user_id:EMAILJS.publicKey,
      template_params:{ to_email:toEmail, to_name:toName || 'there', subject, message } })
  }).then(r => r.ok).catch(() => false);
}
function prettyWhen(date, time){ return new Date(date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', day:'numeric', month:'long'}) + ' at ' + to12h(time); }
function notifyCustomerStatus(bizId, apptId, status){
  const biz = getBusiness(bizId), a = biz && (biz.appointments || []).find(x => x.id === apptId);
  if(!a || !a.customerEmail) return;
  const when = prettyWhen(a.date, a.time);
  if(status === 'upcoming' || status === 'confirmed') sendEmail(a.customerEmail, a.customerName, 'Your appointment is confirmed', biz.name+' has confirmed your '+a.serviceName+' on '+when+'. See you then!');
  else if(status === 'cancelled') sendEmail(a.customerEmail, a.customerName, 'Your appointment was cancelled', biz.name+' could not keep your '+a.serviceName+' booking on '+when+'. Please contact them to pick another time.');
}
function updateAppointmentStatus(bizId, apptId, status){
  const bizRef = db.collection('businesses').doc(bizId);
  const batch = db.batch();
  batch.update(bizRef.collection('appointments').doc(apptId), { status });
  if(status === 'cancelled'){ // free the slot again
    const biz = getBusiness(bizId);
    const a = biz && (biz.appointments || []).find(x => x.id === apptId);
    const slot = a && (biz.busy || []).find(b => b.id === a.date + '_' + a.time);
    if(slot && slot.apptId === apptId) batch.delete(bizRef.collection('busy').doc(slot.id));
  }
  return batch.commit()
    .then(() => notifyCustomerStatus(bizId, apptId, status))
    .catch(err => { console.error('Failed to update appointment', err); showToast('Could not update — check your connection', 'error'); });
}

/* ---------------------------------------------------------------------
   2. PLAN DEFINITIONS + CENTRALISED ACCESS CONTROL
   --------------------------------------------------------------------- */
/* Inline SVG icon set (replaces all emoji). Usage: ICON.home */
const ICON = (function(){
  const wrap = d => '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
  const paths = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/>',
    pin: '<path d="M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    chat: '<path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.7a3.5 3.5 0 010 6.6M18 14.3c2.2.7 3.5 2.6 3.5 5.7"/>',
    chart: '<path d="M3 20h18M6 20v-8M12 20V5M18 20v-11"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    camera: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r=".8"/>'
  };
  const out = {}; Object.keys(paths).forEach(k => out[k] = wrap(paths[k])); return out;
})();

const PLANS = {
  free: {
    id:'free', label:'Free', price:{monthly:0, yearly:0},
    desc:'Establish your online presence before paying.',
    features:{ booking:false, staff:false, analytics:false, promotions:false, customUrl:false, insights:false, reviews:false, removeBranding:false, moreServices:false, morePhotos:false, socialLinks:false, socialWhatsapp:true, socialTiktok:false, socialInstagram:false, whatsappConfirm:false },
    limits:{ services:3, photos:2 }
  },
  starter: {
    id:'starter', label:'Starter', price:{monthly:199, yearly:1999},
    desc:'A more complete online presence.',
    features:{ booking:false, staff:false, analytics:false, promotions:false, customUrl:true, insights:true, reviews:false, removeBranding:false, moreServices:true, morePhotos:true, socialLinks:true, socialWhatsapp:true, socialTiktok:true, socialInstagram:false, whatsappConfirm:false },
    limits:{ services:10, photos:8 }
  },
  business: {
    id:'business', label:'Business', price:{monthly:499, yearly:4999},
    desc:'For businesses that want online bookings.',
    features:{ booking:true, staff:false, analytics:false, promotions:false, customUrl:true, insights:true, reviews:true, removeBranding:false, moreServices:true, morePhotos:true, socialLinks:true, socialWhatsapp:true, socialTiktok:true, socialInstagram:true, whatsappConfirm:true },
    limits:{ services:25, photos:16 }
  },
  pro: {
    id:'pro', label:'Pro', price:{monthly:899, yearly:8999},
    desc:'Manage more of your operations.',
    features:{ booking:true, staff:true, analytics:true, promotions:true, customUrl:true, insights:true, reviews:true, removeBranding:true, moreServices:true, morePhotos:true, socialLinks:true, socialWhatsapp:true, socialTiktok:true, socialInstagram:true, whatsappConfirm:true },
    limits:{ services:999, photos:999 }
  }
};
const PLAN_ORDER = ['free','starter','business','pro'];

/* Default cover photo used across shop cards, headers and the hero mockup
   until a business uploads its own (biz.coverImage). */
const DEFAULT_COVER_IMAGE = 'https://res.cloudinary.com/dbk47jrff/image/upload/v1790334740/cover_img_fypxph.jpg';
function coverStyle(biz){
  const img = safeImgUrl(biz && biz.coverImage, DEFAULT_COVER_IMAGE);
  return `background-image:url('${esc(img)}'); background-size:cover; background-position:center;`;
}

/* Businesses without an uploaded logo (biz.logoImage) get a clean navy square with their first letter. */
function logoStyle(biz){
  const custom = safeImgUrl(biz && biz.logoImage, '');
  if(custom) return `background-image:url('${esc(custom)}'); background-size:cover; background-position:center;`;
  const m = String((biz && biz.name) || 'A').trim().charAt(0).match(/[A-Za-z0-9]/);
  const letter = (m ? m[0] : 'A').toUpperCase();
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='#0D1B2A'/><text x='32' y='45' font-family='Arial,sans-serif' font-size='36' font-weight='700' text-anchor='middle' fill='#FF9F1C'>" + letter + "</text></svg>";
  return 'background-image:url(data:image/svg+xml,' + encodeURIComponent(svg).replace(/'/g, '%27') + '); background-size:cover; background-position:center;';
}

// Centralised feature-access checker — the ONLY place feature gating logic lives.
function checkFeatureAccess(feature, planId){
  const plan = PLANS[planId] || PLANS.free;
  return !!plan.features[feature];
}

function planRank(planId){ return PLAN_ORDER.indexOf(planId); }

/* Feature catalogue shown on the landing page + comparison table */
const FEATURE_CATALOGUE = [
  { key:'profile', label:'Professional business profile', icon:ICON.home, minPlan:'free', desc:'A polished public page for your business.' },
  { key:'servicesPricing', label:'Services & pricing', icon:ICON.scissors, minPlan:'free', desc:'List your services with clear pricing.' },
  { key:'gallery', label:'Photo gallery', icon:ICON.image, minPlan:'free', desc:'Show off your work with photos.' },
  { key:'location', label:'Business location', icon:ICON.pin, minPlan:'free', desc:'Let customers know where to find you.' },
  { key:'whatsapp', label:'WhatsApp contact', icon:ICON.chat, minPlan:'free', desc:'One-tap contact button for customers.' },
  { key:'booking', label:'Appointment booking', icon:ICON.calendar, minPlan:'business', desc:'Accept real online bookings.' },
  { key:'customers', label:'Customer management', icon:ICON.users, minPlan:'business', desc:'Keep track of who books with you.' },
  { key:'staff', label:'Staff management', icon:ICON.users, minPlan:'pro', desc:'Add staff, schedules and assignments.' },
  { key:'analytics', label:'Business analytics', icon:ICON.chart, minPlan:'pro', desc:'Understand bookings and revenue.' },
  { key:'promotions', label:'Promotions', icon:ICON.tag, minPlan:'pro', desc:'Run discounts and offers.' },
  { key:'customPage', label:'Custom business page', icon:ICON.link, minPlan:'starter', desc:'A memorable, shareable link.' },
  { key:'mobileFriendly', label:'Mobile-friendly profile', icon:ICON.phone, minPlan:'free', desc:'Looks great on any device.' }
];

const COMPARE_FEATURES = [
  {label:'Business profile', free:true, starter:true, business:true, pro:true},
  {label:'Number of services', free:'3', starter:'10', business:'25', pro:'Unlimited'},
  {label:'Photo gallery', free:'2 photos', starter:'8 photos', business:'16 photos', pro:'Unlimited'},
  {label:'WhatsApp contact button', free:true, starter:true, business:true, pro:true},
  {label:'Custom business URL (coming soon)', free:false, starter:true, business:true, pro:true},
  {label:'TikTok button', free:false, starter:true, business:true, pro:true},
  {label:'Instagram button', free:false, starter:false, business:true, pro:true},
  {label:'Basic business insights (coming soon)', free:false, starter:true, business:true, pro:true},
  {label:'Online appointment booking', free:false, starter:false, business:true, pro:true},
  {label:'Booking dashboard', free:false, starter:false, business:true, pro:true},
  {label:'WhatsApp booking confirmations', free:false, starter:false, business:true, pro:true},
  {label:'Customer reviews (coming soon)', free:false, starter:false, business:true, pro:true},
  {label:'Staff management', free:false, starter:false, business:false, pro:true},
  {label:'Advanced analytics', free:false, starter:false, business:false, pro:true},
  {label:'Promotions & discounts (coming soon)', free:false, starter:false, business:false, pro:true},
  {label:'Remove Aura branding (coming soon)', free:false, starter:false, business:false, pro:true},
  {label:'Priority support', free:false, starter:false, business:false, pro:true},
];

/* ---------------------------------------------------------------------
   4. AUTH (Firebase Auth)
   Role is derived, not stored in a separate "users" collection:
   - the one Firebase account whose uid === ADMIN_UID is the platform admin
   - a business owner is whoever's uid matches that business's ownerUid field
   --------------------------------------------------------------------- */
let currentAuthUser = null;
let authReady = false;

auth.onAuthStateChanged(fbUser => {
  if(!fbUser){
    currentAuthUser = null;
    stopApplicationsListener();
    authReady = true;
    updateAuthNav();
    renderRoute();
    return;
  }
  whenCacheReady(() => {
    if(fbUser.uid === ADMIN_UID){
      currentAuthUser = { uid: fbUser.uid, email: fbUser.email, role:'admin', name:'Platform Admin' };
      startApplicationsListener();
    } else {
      const biz = getBusinesses().find(b => b.ownerUid === fbUser.uid);
      if(biz){
        currentAuthUser = { uid: fbUser.uid, email: fbUser.email, role:'owner', businessId: biz.id, name: biz.name + ' Owner' };
      } else {
        currentAuthUser = null;
        auth.signOut();
        showToast("This account isn't linked to a business. Contact us on WhatsApp to get set up.", 'error');
      }
    }
    authReady = true;
    updateAuthNav();
    renderRoute();
  });
});

function getCurrentUser(){ return currentAuthUser; }
function logoutUser(){ auth.signOut(); }
function isAdminEmail(email){ return (email||'').trim().toLowerCase() === 'admin@aura.co.ke'; }

/* Creates a Firebase Auth account WITHOUT signing the browser into it — used
   when the admin adds a business so the admin's own session stays logged in.
   This is a well-known client-side workaround; moving it into a Cloud
   Function later is a drop-in replacement, nothing else needs to change. */
function createOwnerAccount(email, password){
  const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary-' + Date.now());
  return secondaryApp.auth().createUserWithEmailAndPassword(email, password)
    .then(cred => {
      const uid = cred.user.uid;
      return secondaryApp.auth().signOut().then(() => secondaryApp.delete()).then(() => uid);
    })
    .catch(err => secondaryApp.delete().then(() => { throw err; }));
}

function localISO(d){ d = d || new Date(); const p = n => String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
function slugify(s){ return (s||'business').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function categoryEmoji(cat){ return ''; } // emoji no longer used; the field is kept (empty) so the data shape is unchanged

/* ---------------------------------------------------------------------
   5. GLOBAL APP STATE (in-memory, per-session UI state)
   --------------------------------------------------------------------- */
const AppState = {
  billingCycle: 'monthly',
  discoverFilter: 'All',
  discoverSearch: '',
  currentBusinessId: null,
  dashSection: 'overview',
  adminSection: 'overview',
  booking: null // in-progress booking flow state
};

/* ---------------------------------------------------------------------
   7. TOASTS
   --------------------------------------------------------------------- */
function showToast(message, type){
  type = type || 'success';
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span class="dot"></span><span>'+escapeHtml(message)+'</span>';
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3200);
}
/* Escapes text for safe use inside HTML (element text AND quoted attributes).
   Anything that comes from a user or the database must pass through this
   before it is written into a template string. */
function esc(v){
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeHtml(str){ return esc(str); }

/* Only real image data/https URLs with nothing that could break out of CSS url('...') */
function safeImgUrl(v, fallback){
  if(typeof v === 'string' && v.length < 3000000){
    if(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(v)) return v;
    if(/^https:\/\/[^\s'"()<>\\]+$/.test(v)) return v;
  }
  return fallback || '';
}
function safeColor(v){ return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : 'transparent'; }
function starCount(n){ n = Math.round(Number(n)); return isNaN(n) ? 0 : Math.max(0, Math.min(5, n)); }
function fmtKsh(n){ return 'KSh ' + Number(n||0).toLocaleString('en-KE'); }

/* ---------------------------------------------------------------------
   8. MODAL
   --------------------------------------------------------------------- */
function openModal(html){
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(){
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('modal-box').innerHTML = '';
  AppState.booking = null;
}
document.addEventListener('keydown', e => { if(e.key === 'Escape' && document.getElementById('modal-overlay').classList.contains('open')) closeModal(); });
document.getElementById('modal-overlay').addEventListener('click', (e)=>{
  if(e.target.id === 'modal-overlay') closeModal();
});

/* ---------------------------------------------------------------------
   9. ROUTER
   --------------------------------------------------------------------- */
function navigate(hash){
  window.location.hash = hash;
}
function getRoute(){
  const raw = window.location.hash.replace('#','') || 'home';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query||'');
  const segments = path.split('/');
  return { view: segments[0] || 'home', sub: segments[1] || null, params };
}

function showBootLoader(on){
  const el = document.getElementById('boot-loader'); if(!el) return;
  el.style.display = on ? 'flex' : 'none';
  if(on){
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('public-nav').style.display = 'none';
    document.getElementById('public-footer').style.display = 'none';
  }
}

let lastRenderedHash = null;
function refreshRoute(){
  const ae = document.activeElement;
  if(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.closest('#dash-content,#admin-content,#view-register')) return;
  renderRoute();
}
function renderRoute(){
  const route = getRoute();
  const publicViews = ['home','pricing','discover','business','login'];
  const isAppView = route.view === 'dashboard' || route.view === 'admin';

  // Guard: dashboard/admin require a logged in user. We wait for authReady
  // before redirecting, so a page refresh while genuinely logged in doesn't
  // momentarily bounce to the login page before Firebase reports the
  // existing session back to us.
  const user = getCurrentUser();
  if(isAppView && !authReady){
    showBootLoader(true); // never leave a blank or stale page while the saved login is being restored
    return; // onAuthStateChanged will call renderRoute() again once it resolves
  }
  showBootLoader(false);
  if(route.view === 'dashboard' && (!user || user.role !== 'owner')){
    navigate('login'); return;
  }
  if(route.view === 'admin' && (!user || user.role !== 'admin')){
    navigate('login'); return;
  }

  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const target = document.getElementById('view-'+route.view) ? route.view : 'home';
  document.getElementById('view-'+target).classList.add('active');

  document.getElementById('public-nav').style.display = isAppView ? 'none' : '';
  document.getElementById('public-footer').style.display = isAppView ? 'none' : '';
  document.body.style.background = ''; // reset

  document.querySelectorAll('[data-nav]').forEach(el=>{
    el.classList.toggle('active', el.getAttribute('data-nav') === target);
  });
  document.getElementById('mobile-nav').classList.remove('open');

  if(window.location.hash !== lastRenderedHash){ window.scrollTo({top:0, behavior:'instant'}); lastRenderedHash = window.location.hash; }

  if(target === 'home') renderHome();
  else if(target === 'pricing') renderPricing();
  else if(target === 'discover') renderDiscover();
  else if(target === 'business') renderBusinessProfile(route.params.get('id') || AppState.currentBusinessId || '');
  else if(target === 'login') { /* static */ }
  else if(target === 'register') renderRegister(route.params);
  else if(target === 'dashboard') renderDashboard(route.sub || AppState.dashSection);
  else if(target === 'admin') renderAdmin(route.sub || AppState.adminSection);

  updateAuthNav();
}

function updateAuthNav(){
  const user = getCurrentUser();
  const loginBtn = document.getElementById('nav-login-btn');
  const signupBtn = document.getElementById('nav-signup-btn');
  if(user && user.role === 'owner'){
    loginBtn.textContent = 'Dashboard'; loginBtn.setAttribute('href','#dashboard'); loginBtn.setAttribute('data-nav','dashboard');
    signupBtn.textContent = 'Log out'; signupBtn.setAttribute('href','#'); signupBtn.removeAttribute('target'); signupBtn.removeAttribute('rel'); signupBtn.onclick = (e)=>{ e.preventDefault(); logoutUser(); navigate('home'); showToast('Logged out'); };
  } else if(user && user.role === 'admin'){
    loginBtn.textContent = 'Admin'; loginBtn.setAttribute('href','#admin'); loginBtn.setAttribute('data-nav','admin');
    signupBtn.textContent = 'Log out'; signupBtn.setAttribute('href','#'); signupBtn.removeAttribute('target'); signupBtn.removeAttribute('rel'); signupBtn.onclick = (e)=>{ e.preventDefault(); logoutUser(); navigate('home'); showToast('Logged out'); };
  } else {
    loginBtn.textContent = 'Log in'; loginBtn.setAttribute('href','#login'); loginBtn.setAttribute('data-nav','login'); loginBtn.onclick = null;
    signupBtn.textContent = 'List Your Business'; signupBtn.setAttribute('href','#register'); signupBtn.removeAttribute('target'); signupBtn.removeAttribute('rel'); signupBtn.removeAttribute('data-nav'); signupBtn.onclick = null;
  }
}

window.addEventListener('hashchange', renderRoute);

document.addEventListener('click', (e)=>{
  const navEl = e.target.closest('[data-nav]');
  if(navEl && navEl.tagName !== 'A'){ navigate(navEl.getAttribute('data-nav')); }
});

/* ---------------------------------------------------------------------
   10. LANDING PAGE — features grid
   --------------------------------------------------------------------- */
function renderHome(){
  const grid = document.getElementById('features-grid');
  const SHOWN = ['booking','whatsapp','gallery','customers','analytics','customPage'];
  grid.innerHTML = FEATURE_CATALOGUE.filter(f => SHOWN.includes(f.key)).map(f => `
    <div class="feature-card">
      <div class="fi">${f.icon}</div>
      <h4>${f.label}</h4>
      <p>${f.desc}</p>
      <span class="feature-plan-tag">${f.minPlan === 'free' ? 'All plans' : PLANS[f.minPlan].label + '+'}</span>
    </div>
  `).join('');
  renderHomeShopsRow();
}

function renderHomeShopsRow(){
  const row = document.getElementById('home-shops-row');
  if(!row) return;
  const businesses = getPublicBusinesses();
  if(!businesses.length){ row.innerHTML = '<p class="text-muted" style="padding:8px 0;">New businesses are joining Aura every week — check back soon.</p>'; return; }
  row.innerHTML = businesses.map(b => `
    <div class="shop-card">
      <div class="shop-photo" style="${coverStyle(b)}"></div>
      <div class="shop-logo" style="${logoStyle(b)}"></div>
      <a href="#business?id=${esc(b.id)}" class="shop-name">${esc(b.name)}</a>
      <div class="shop-cat">${esc(b.category)} · ${esc(b.location)}</div>
    </div>
  `).join('');
}

/* ---------------------------------------------------------------------
   11. PRICING PAGE
   --------------------------------------------------------------------- */
function renderPricing(){
  const grid = document.getElementById('pricing-grid');
  const cycle = AppState.billingCycle;
  grid.innerHTML = PLAN_ORDER.map(pid=>{
    const p = PLANS[pid];
    const popular = pid === 'business';
    const price = p.price[cycle];
    const perLabel = pid === 'free' ? '' : (cycle === 'monthly' ? '/month' : '/year');
    let annualNote = '';
    if(cycle === 'yearly' && pid !== 'free'){
      const monthlyCost = p.price.monthly * 12;
      const savings = monthlyCost - p.price.yearly;
      const pct = Math.round((savings/monthlyCost)*100);
      annualNote = `Save ${fmtKsh(savings)} (${pct}%) vs monthly`;
    }
    return `
      <div class="price-card ${popular?'popular':''}">
        ${popular?'<span class="popular-tag">Most Popular</span>':''}
        <h3>${p.label}</h3>
        <p class="plan-desc">${p.desc}</p>
        <div class="price-amount"><span class="num">${fmtKsh(price)}</span><span class="per">${perLabel}</span></div>
        <div class="price-annual-note">${annualNote}</div>
        <ul class="price-features">
          ${pricingBullets(pid).map(b=>`<li><span class="ck">✓</span>${esc(b)}</li>`).join('')}
        </ul>
        <a href="#register?plan=${pid}" class="btn ${popular?'btn-accent':'btn-outline'} btn-block">${pid==='free'?'Get Started Free':'Choose '+p.label}</a>
      </div>
    `;
  }).join('');

  const switchEl = document.getElementById('billing-switch');
  switchEl.classList.toggle('on', cycle === 'yearly');

  renderCompareTable();
}

function pricingBullets(pid){
  const base = {
    free: ['Business profile & page', '3 services listed', '2 photos', 'WhatsApp button', 'Opening hours & location'],
    starter: ['Everything in Free', '10 services listed', '8 photos', 'Custom business URL (coming soon)', 'WhatsApp + TikTok buttons', 'Basic business insights (coming soon)'],
    business: ['Everything in Starter', '25 services listed', 'WhatsApp + TikTok + Instagram', 'Online appointment booking', 'Booking dashboard', 'WhatsApp booking confirmations', 'Customer reviews (coming soon)'],
    pro: ['Everything in Business', 'Unlimited services & photos', 'Staff management', 'Advanced analytics', 'Promotions & discounts (coming soon)', 'Remove Aura branding (coming soon)']
  };
  return base[pid];
}

function renderCompareTable(){
  const table = document.getElementById('compare-table');
  const head = `<thead><tr><th>Feature</th><th>Free</th><th>Starter</th><th>Business</th><th>Pro</th></tr></thead>`;
  const rows = COMPARE_FEATURES.map(row=>{
    const cell = (v)=> typeof v === 'boolean' ? (v ? '<span class="yes">✓</span>' : '<span class="no">—</span>') : `<span>${esc(v)}</span>`;
    return `<tr><td>${row.label}</td><td>${cell(row.free)}</td><td>${cell(row.starter)}</td><td>${cell(row.business)}</td><td>${cell(row.pro)}</td></tr>`;
  }).join('');
  table.innerHTML = head + '<tbody>' + rows + '</tbody>';
}

document.getElementById('billing-switch').addEventListener('click', ()=>{
  AppState.billingCycle = AppState.billingCycle === 'monthly' ? 'yearly' : 'monthly';
  renderPricing();
});

/* ---------------------------------------------------------------------
   12. DISCOVERY PAGE
   --------------------------------------------------------------------- */
const DISCOVER_CATEGORIES = ['All','Barbershop','Salon','Spa','Nail studio','Massage','Other'];

function renderDiscover(){
  const filterWrap = document.getElementById('discover-filters');
  filterWrap.innerHTML = DISCOVER_CATEGORIES.map(c=>
    `<button class="chip ${AppState.discoverFilter===c?'active':''}" data-cat="${esc(c)}">${esc(c)}</button>`
  ).join('');
  filterWrap.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{ AppState.discoverFilter = chip.getAttribute('data-cat'); renderDiscover(); });
  });

  const searchInput = document.getElementById('discover-search');
  searchInput.value = AppState.discoverSearch;
  searchInput.oninput = ()=>{ AppState.discoverSearch = searchInput.value; renderBizGrid(); };

  renderBizGrid();
}

function isOpenNow(biz){
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', {weekday:'long'});
  const todayHours = (biz.hours||[]).find(h=>h.day===dayName);
  if(!todayHours || todayHours.open === 'Closed') return false;
  const [oh,om] = todayHours.open.split(':').map(Number);
  const [ch,cm] = todayHours.close.split(':').map(Number);
  const openMins = oh*60+om, closeMins = ch*60+cm;
  const nowMins = now.getHours()*60+now.getMinutes();
  return nowMins >= openMins && nowMins <= closeMins;
}

function renderBizGrid(){
  const grid = document.getElementById('biz-grid');
  const q = AppState.discoverSearch.trim().toLowerCase();
  const cat = AppState.discoverFilter;
  let list = getPublicBusinesses().filter(b=>{
    const matchCat = cat === 'All' || b.category === cat;
    const matchQ = !q || b.name.toLowerCase().includes(q) || b.category.toLowerCase().includes(q) || (b.services||[]).some(s=>s.name.toLowerCase().includes(q));
    return matchCat && matchQ;
  });

  if(!list.length){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="ico">${ICON.search}</div><h4>No businesses found</h4><p>Try a different search term or category.</p></div>`;
    return;
  }

  grid.innerHTML = list.map(b=>{
    const open = isOpenNow(b);
    return `
    <div class="biz-card" data-biz="${esc(b.id)}" tabindex="0" role="link">
      <div class="biz-cover" style="${coverStyle(b)}">
        <span class="biz-status ${open?'open':'closed'}">${open?'Open now':'Closed'}</span>
        <div class="biz-logo" style="${logoStyle(b)}"></div>
      </div>
      <div class="biz-info">
        <div class="flex-between">
          <span class="cat">${esc(b.category)}</span>
        </div>
        <h4>${esc(b.name)}</h4>
        <div class="biz-rating"><span class="stars">★</span> ${esc(b.rating || 'New')} ${esc(b.reviewCount? '('+b.reviewCount+')':'')} · ${esc(b.location)}</div>
        <p class="biz-desc">${esc((b.description||'').slice(0,90))}${b.description && b.description.length>90?'…':''}</p>
        <div class="biz-foot">
          <span class="biz-price">${b.priceFrom ? 'From '+fmtKsh(b.priceFrom) : 'New listing'}</span>
          <span class="btn btn-outline btn-sm">View Business</span>
        </div>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.biz-card').forEach(card=>{
    const go = ()=>{ AppState.currentBusinessId = card.getAttribute('data-biz'); navigate('business?id='+card.getAttribute('data-biz')); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); go(); } });
  });
}

/* ---------------------------------------------------------------------
   13. BUSINESS PROFILE PAGE
   --------------------------------------------------------------------- */
/* ---- Plan-gated social buttons ---- */
function getAllowedSocials(biz){
  const socials = [];
  if(biz.whatsapp && checkFeatureAccess('socialWhatsapp', biz.plan)){
    socials.push({ key:'whatsapp', label:'WhatsApp', icon:ICON.chat, url:'https://wa.me/'+bizWaDigits(biz) });
  }
  if(biz.socialLinks && biz.socialLinks.tiktok && checkFeatureAccess('socialTiktok', biz.plan)){
    socials.push({ key:'tiktok', label:'TikTok', icon:ICON.music, url:'https://www.tiktok.com/@'+encodeURIComponent(String(biz.socialLinks.tiktok).replace('@','').trim()) });
  }
  if(biz.socialLinks && biz.socialLinks.instagram && checkFeatureAccess('socialInstagram', biz.plan)){
    socials.push({ key:'instagram', label:'Instagram', icon:ICON.camera, url:'https://www.instagram.com/'+encodeURIComponent(String(biz.socialLinks.instagram).replace('@','').trim()) });
  }
  return socials;
}
function renderSocialButtons(biz, excludeKeys){
  excludeKeys = excludeKeys || [];
  const socials = getAllowedSocials(biz).filter(s => !excludeKeys.includes(s.key));
  if(!socials.length) return '';
  return `<div class="social-btns">${socials.map(s=>`<a class="social-btn" title="${esc(s.label)}" aria-label="${esc(s.label)}" target="_blank" rel="noopener" href="${esc(s.url)}">${s.icon}</a>`).join('')}</div>`;
}

function renderBusinessProfile(id){
  const biz = getBusiness(id) || (id ? null : getPublicBusinesses()[0]);
  if(!biz){ document.getElementById('business-content').innerHTML = '<div class="container" style="padding:80px 0;"><div class="empty-state"><h4>Business not found</h4></div></div>'; return; }
  const viewer = auth.currentUser;
  const privileged = !!viewer && (viewer.uid === ADMIN_UID || viewer.uid === biz.ownerUid);
  if(isSuspended(biz) && !privileged){
    document.getElementById('business-content').innerHTML = '<div class="container" style="padding:90px 0;"><div class="empty-state"><h4>This business is temporarily unavailable</h4><p>Please check back soon, or browse other businesses on Aura.</p><a class="btn btn-primary mt16" href="#discover">Browse businesses</a></div></div>';
    return;
  }
  const suspendedNotice = isSuspended(biz) ? '<div class="container" style="padding-top:16px;"><div class="suspend-banner"><b>This business is suspended.</b> Only you can see this page. Customers see &ldquo;temporarily unavailable&rdquo; and cannot book.</div></div>' : '';
  AppState.currentBusinessId = biz.id;
  ensureBusyListener(biz.id); // public page: only taken slots, never customer details
  const open = isOpenNow(biz);
  const now = new Date();
  const todayName = now.toLocaleDateString('en-US', {weekday:'long'});
  const bookingEnabled = checkFeatureAccess('booking', biz.plan);

  const html = `
    ${suspendedNotice}
    <div class="biz-header-cover" style="${coverStyle(biz)}"></div>
    <div class="container biz-header-wrap">
      <div class="biz-header-inner">
        <div class="biz-header-left">
          <div class="biz-header-logo" style="${logoStyle(biz)}"></div>
          <div class="biz-header-name">
            <h1>${esc(biz.name)}</h1>
            <div class="biz-header-meta">
              <span>${esc(biz.category)}</span><span>·</span>
              <span class="mockup-stars" style="color:var(--accent)">★★★★★</span><span>${esc(biz.rating||'New')} ${esc(biz.reviewCount?'('+biz.reviewCount+' reviews)':'')}</span>
              <span>·</span><span>${ICON.pin} ${esc(biz.location)}</span>
              <span>·</span><span style="color:${open?'var(--teal)':'var(--danger)'};font-weight:600;">${open ? 'Open now' : 'Closed now'}</span>
            </div>
          </div>
        </div>
        <div class="biz-header-actions">
          ${renderSocialButtons(biz)}
          <button class="btn btn-primary" id="book-appt-btn">Book Appointment</button>
        </div>
      </div>

      <div class="profile-layout">
        <div>
          <nav class="profile-nav">
            <a href="#p-about" class="active">About</a>
            <a href="#p-services">Services</a>
            <a href="#p-gallery">Gallery</a>
            <a href="#p-hours">Hours</a>
            <a href="#p-location">Location</a>
            <a href="#p-reviews">Reviews</a>
          </nav>

          <div class="profile-section" id="p-about">
            <h3>About</h3>
            <p style="color:var(--muted);line-height:1.7;">${esc(biz.description)}</p>
          </div>

          <div class="profile-section" id="p-services">
            <h3>Services</h3>
            ${(biz.services||[]).length ? biz.services.map(s=>`
              <div class="service-row">
                <div class="sinfo">
                  <h4>${esc(s.name)} <span class="price-tag">${fmtKsh(s.price)}</span></h4>
                  <p>${esc(s.description||'')}</p>
                  <div class="dur">⏱ ${esc(s.duration)} min</div>
                </div>
                <button class="btn btn-outline btn-sm" data-book-service="${esc(s.id)}">Book</button>
              </div>
            `).join('') : `<div class="empty-state"><div class="ico">${ICON.scissors}</div><h4>No services listed yet</h4></div>`}
          </div>

          <div class="profile-section" id="p-gallery">
            <h3>Gallery</h3>
            ${(biz.gallery||[]).length ? `<div class="gallery-grid">${biz.gallery.map(c=> safeImgUrl(c) ? `<div class="g" style="background-image:url('${esc(safeImgUrl(c))}');background-size:cover;background-position:center;"></div>` : `<div class="g" style="background:${safeColor(c)}"></div>`).join('')}</div>` : `<div class="empty-state"><div class="ico">${ICON.image}</div><h4>No photos yet</h4></div>`}
          </div>

          <div class="profile-section" id="p-hours">
            <h3>Opening Hours</h3>
            <div>${(biz.hours||[]).map(h=>`<div class="hours-row ${h.day===todayName?'today':''}"><span>${esc(h.day)}</span><span>${esc(h.open==='Closed'?'Closed':h.open+' – '+h.close)}</span></div>`).join('')}</div>
          </div>

          <div class="profile-section" id="p-location">
            <h3>Location</h3>
            <div class="map-placeholder"><span style="font-size:26px;">${ICON.pin}</span>${esc(biz.location)}<span style="font-size:12px;">Map coming soon</span></div>
          </div>

          <div class="profile-section" id="p-reviews">
            <h3>Reviews</h3>
            ${(biz.reviews||[]).length ? biz.reviews.map(r=>`
              <div class="review-card">
                <div class="review-head"><span class="review-name">${esc(r.name)}</span><span class="review-stars">${'★'.repeat(starCount(r.rating))}${'☆'.repeat(5-starCount(r.rating))}</span></div>
                <p class="review-text">${esc(r.text)}</p>
              </div>
            `).join('') : `<div class="empty-state"><div class="ico">${ICON.star}</div><h4>No reviews yet</h4></div>`}
          </div>
        </div>

        <aside>
          <div class="sidebar-card">
            <h5>Starting from</h5>
            <div style="font-family:var(--font-display);font-size:22px;font-weight:700;color:var(--accent-ink);">${biz.priceFrom?fmtKsh(biz.priceFrom):'—'}</div>
          </div>
          <div class="sidebar-card">
            <h5>Contact</h5>
            ${biz.whatsapp && checkFeatureAccess('socialWhatsapp', biz.plan) ? `<a class="btn btn-outline btn-block btn-sm" style="margin-bottom:8px;" target="_blank" rel="noopener" href="https://wa.me/${esc(bizWaDigits(biz))}">${ICON.chat} Message on WhatsApp</a>`:''}
            <button class="btn btn-primary btn-block btn-sm" id="book-appt-btn-2">${ICON.calendar} Book Appointment</button>
            <button class="btn btn-outline btn-block btn-sm mt8" id="share-page-btn">${ICON.link} Share this page</button>
          </div>
          ${renderSocialButtons(biz, ['whatsapp']) ? `
          <div class="sidebar-card">
            <h5>Follow</h5>
            ${renderSocialButtons(biz, ['whatsapp'])}
          </div>`:''}
        </aside>
      </div>
    </div>
  `;
  document.getElementById('business-content').innerHTML = html;

  // profile sub-nav active state on click (simple, no scroll-spy needed for prototype)
  document.querySelectorAll('.profile-nav a').forEach(a=>{
    a.addEventListener('click', (e)=>{
      e.preventDefault(); const t = document.querySelector(a.getAttribute('href')); if(t) t.scrollIntoView({behavior:'smooth', block:'start'});
      document.querySelectorAll('.profile-nav a').forEach(x=>x.classList.remove('active'));
      a.classList.add('active');
    });
  });

  const openBooking = ()=> {
    if(isSuspended(biz)){ showToast('This business is not taking bookings right now.', 'error'); return; }
    if(!bookingEnabled){
      openModal(upgradeNeededModal('booking', biz));
      return;
    }
    openBookingModal(biz);
  };
  const b1 = document.getElementById('book-appt-btn'); if(b1) b1.addEventListener('click', openBooking);
  const b2 = document.getElementById('book-appt-btn-2'); if(b2) b2.addEventListener('click', openBooking);
  const shareBtn = document.getElementById('share-page-btn');
  if(shareBtn) shareBtn.addEventListener('click', ()=>{
    const link = getShareLink(biz.id);
    if(navigator.share){
      navigator.share({ title: biz.name, text: 'Check out '+biz.name+' on Aura', url: link }).catch(()=>{});
    } else {
      copyToClipboard(link);
    }
  });
  document.querySelectorAll('[data-book-service]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(isSuspended(biz)){ showToast('This business is not taking bookings right now.', 'error'); return; }
      if(!bookingEnabled){ openModal(upgradeNeededModal('booking', biz)); return; }
      openBookingModal(biz, btn.getAttribute('data-book-service'));
    });
  });
}

function upgradeNeededModal(feature, biz){
  return `
    <div class="modal-head"><h3>Booking not available yet</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="locked-card">
        <div class="ico">${ICON.lock}</div>
        <h3>${esc(biz.name)} hasn't enabled online booking</h3>
        <p>This business is on a plan that doesn't include appointment booking yet. Try contacting them on WhatsApp instead.</p>
        ${biz.whatsapp ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/${esc(bizWaDigits(biz))}">${ICON.chat} Message on WhatsApp</a>` : ''}
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------
   14. BOOKING FLOW (customer-facing)
   --------------------------------------------------------------------- */
function openBookingModal(biz, preselectServiceId){
  if(isSuspended(biz)){ showToast('This business is not taking bookings right now.', 'error'); return; }
  AppState.booking = { bizId: biz.id, step:1, serviceId: preselectServiceId || null, date:null, time:null, name:'', phone:'', email:'' };
  openModal('');
  renderBookingStep();
}

function nextAvailableDates(){
  const days = [];
  for(let i=0;i<8;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    days.push(d);
  }
  return days;
}

function slotsFor(biz, iso, svc){
  const day = new Date(iso+'T00:00:00').toLocaleDateString('en-US',{weekday:'long'});
  const h = (biz.hours||[]).find(x=>x.day===day);
  if(!h || h.open==='Closed') return [];
  const toM = t => { const [a,b] = t.split(':').map(Number); return a*60+b; };
  const dur = parseInt(svc && svc.duration,10) || 60, now = new Date(), isToday = iso === localISO(now), nowM = now.getHours()*60+now.getMinutes(), out = [];
  for(let m = toM(h.open); m+dur <= toM(h.close); m += 60){
    if(isToday && m <= nowM) continue;
    out.push(String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'));
  }
  return out;
}
function renderBookingStep(){
  const st = AppState.booking;
  const biz = getBusiness(st.bizId);
  const stepsHtml = `<div class="booking-steps">${[1,2,3,4,5].map(n=>`<div class="bstep ${st.step>n?'done':st.step===n?'current':''}"></div>`).join('')}</div>`;

  let body = '';
  if(st.step === 1){
    body = `
      <h3 style="margin-bottom:14px;">Select a service</h3>
      ${biz.services.map(s=>`
        <div class="svc-pick ${st.serviceId===s.id?'selected':''}" data-svc="${esc(s.id)}">
          <div><b>${esc(s.name)}</b><div class="text-muted" style="font-size:12.5px;margin-top:3px;">${esc(s.duration)} min</div></div>
          <b class="price-tag">${fmtKsh(s.price)}</b>
        </div>
      `).join('')}
    `;
  } else if(st.step === 2){
    const dates = nextAvailableDates();
    body = `
      <h3 style="margin-bottom:14px;">Select a date</h3>
      <div class="date-grid">
        ${dates.map(d=>{
          const iso = localISO(d);
          const label = d.toLocaleDateString('en-US',{weekday:'short'});
          const num = d.getDate();
          return `<div class="date-pick ${st.date===iso?'selected':''}" data-date="${iso}"><div>${label}</div><div style="font-weight:700;font-size:15px;">${num}</div></div>`;
        }).join('')}
      </div>
    `;
  } else if(st.step === 3){
    const times = slotsFor(biz, st.date, biz.services.find(s=>s.id===st.serviceId));
    const takenTimes = (biz.busy||[]).filter(b=>b.date===st.date).map(b=>b.time)
      .concat((biz.appointments||[]).filter(a=>a.date===st.date && a.status!=='cancelled').map(a=>a.time));
    body = `
      <h3 style="margin-bottom:14px;">Select a time</h3>
      ${times.length ? '' : '<p class="text-muted">The business is closed or fully past for this day. Go back and pick another date.</p>'}<div class="time-grid">
        ${times.map(t=>{
          const taken = takenTimes.includes(t);
          return `<div class="time-pick ${st.time===t?'selected':''} ${taken?'taken':''}" data-time="${taken?'':t}">${to12h(t)}</div>`;
        }).join('')}
      </div>
    `;
  } else if(st.step === 4){
    body = `
      <h3 style="margin-bottom:14px;">Your details</h3>
      <div class="field" id="bf-name"><label>Name</label><input id="booking-name" maxlength="80" value="${esc(st.name)}" placeholder="Full name"><div class="err">Enter your name.</div></div>
      <div class="field" id="bf-phone"><label>Phone number</label><input id="booking-phone" maxlength="20" value="${esc(st.phone)}" placeholder="07XX XXX XXX"><div class="err">Enter a valid phone number.</div><div class="text-muted" style="font-size:12px;margin-top:6px;">The business may confirm your appointment on WhatsApp using this number.</div></div>
      <div class="field"><label>Email (optional)</label><input id="booking-email" maxlength="120" value="${esc(st.email)}" placeholder="you@example.com"></div>
      <div aria-hidden="true" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;"><label>Website</label><input id="booking-website" tabindex="-1" autocomplete="off" maxlength="60"></div>
    `;
  } else if(st.step === 5){
    const svc = biz.services.find(s=>s.id===st.serviceId);
    const dateObj = new Date(st.date+'T00:00:00');
    body = `
      <h3 style="margin-bottom:14px;">Booking summary</h3>
      <div class="summary-row"><span>Business</span><b>${esc(biz.name)}</b></div>
      <div class="summary-row"><span>Service</span><span>${esc(svc.name)}</span></div>
      <div class="summary-row"><span>Date</span><span>${dateObj.toLocaleDateString('en-US',{weekday:'long', day:'numeric', month:'long'})}</span></div>
      <div class="summary-row"><span>Time</span><span>${to12h(st.time)}</span></div>
      <div class="summary-row"><span>Name</span><span>${esc(st.name)}</span></div>
      <div class="summary-row"><span>Phone</span><span>${esc(st.phone)}</span></div>
      <div class="summary-row"><span>Total</span><span>${fmtKsh(svc.price)}</span></div>
    `;
  } else if(st.step === 'success'){
    const sSvc = biz.services.find(s=>s.id===st.serviceId) || {};
    const bizNum = biz.whatsapp ? waNumber(biz.whatsapp) : '';
    const myMsg = 'Hi, this is ' + st.name + '. I just booked ' + (sSvc.name || 'an appointment') + ' on ' + new Date(st.date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', day:'numeric', month:'long'}) + ' at ' + to12h(st.time) + '. Please confirm if it is available.';
    const waBtn = (bizNum && checkFeatureAccess('socialWhatsapp', biz.plan)) ? `<a class="btn btn-outline mt16" target="_blank" rel="noopener" href="https://wa.me/${bizNum}?text=${encodeURIComponent(myMsg)}">${ICON.chat} Message ${esc(biz.name)} on WhatsApp</a><br>` : '';
    const calBtn = (st.date && st.time && sSvc.name) ? `<a class="btn btn-outline mt16" download="appointment.ics" href="data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(biz, sSvc, st))}">${ICON.calendar} Add to calendar</a><br>` : '';
    document.getElementById('modal-box').innerHTML = `
      <div class="modal-body booking-success">
        <div class="ico">✓</div>
        <h3>Appointment Request Sent</h3>
        <p class="text-muted mt8">Your appointment has been booked with <b>${esc(biz.name)}</b>. They'll confirm it shortly, usually on WhatsApp.</p>
        ${waBtn}
        ${calBtn}
        <button class="btn btn-primary mt24" onclick="closeModal()">Done</button>
      </div>
    `;
    return;
  }

  const canProceed = bookingCanProceed();
  document.getElementById('modal-box').innerHTML = `
    <div class="modal-head"><h3>Book Appointment</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">${stepsHtml}${body}</div>
    <div class="modal-foot">
      ${st.step>1 ? `<button class="btn btn-ghost" id="booking-back">Back</button>` : `<span></span>`}
      <button class="btn btn-primary" id="booking-next" ${canProceed?'':'disabled'}>${st.step===5?'Confirm Appointment':'Continue'}</button>
    </div>
  `;
  wireBookingStep(biz);
}

function to12h(t){
  const [h,m] = t.split(':').map(Number);
  const period = h>=12?'PM':'AM';
  const h12 = h%12===0?12:h%12;
  return h12+':'+String(m).padStart(2,'0')+' '+period;
}

function bookingCanProceed(){
  const st = AppState.booking;
  if(st.step===1) return !!st.serviceId;
  if(st.step===2) return !!st.date;
  if(st.step===3) return !!st.time;
  if(st.step===4) return st.name.trim().length>1 && validPhone(st.phone) && (!(st.email||'').trim() || validEmail(st.email));
  return true;
}

function wireBookingStep(biz){
  const st = AppState.booking;
  document.querySelectorAll('.svc-pick').forEach(el=>el.addEventListener('click', ()=>{ st.serviceId = el.getAttribute('data-svc'); renderBookingStep(); }));
  document.querySelectorAll('.date-pick').forEach(el=>el.addEventListener('click', ()=>{ st.date = el.getAttribute('data-date'); st.time = null; renderBookingStep(); }));
  document.querySelectorAll('.time-pick:not(.taken)').forEach(el=>el.addEventListener('click', ()=>{ st.time = el.getAttribute('data-time'); renderBookingStep(); }));

  const backBtn = document.getElementById('booking-back');
  if(backBtn) backBtn.addEventListener('click', ()=>{ st.step -= 1; renderBookingStep(); });

  const nextBtn = document.getElementById('booking-next');
  if(nextBtn) nextBtn.addEventListener('click', ()=>{
    if(st.step === 4){
      st.name = document.getElementById('booking-name').value.trim();
      st.phone = document.getElementById('booking-phone').value.trim();
      st.email = (document.getElementById('booking-email')||{}).value || '';
      st.trap = (document.getElementById('booking-website')||{}).value || '';
      if(!bookingCanProceed()){ showToast('Please enter your name, a valid phone number and (if given) a valid email', 'error'); return; }
    }
    if(st.step === 5){
      nextBtn.disabled = true;
      confirmBooking(biz);
      return;
    }
    st.step += 1;
    renderBookingStep();
  });

  if(st.step===4){
    ['booking-name','booking-phone','booking-email'].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.addEventListener('input', ()=>{ document.getElementById('booking-next').disabled = false; });
    });
  }
}

function confirmBooking(biz){
  const st = AppState.booking;
  const svc = biz.services.find(s=>s.id===st.serviceId);
  const nb = () => document.getElementById('booking-next');
  // Bots fill every field, including the hidden one. Pretend it worked and store nothing.
  if(st.trap){ st.step = 'success'; renderBookingStep(); return; }
  // Light per-device limit. The real limits are: one booking per time slot, and Firebase App Check.
  try {
    const now = Date.now();
    const recent = JSON.parse(localStorage.getItem('aura_bookings') || '[]').filter(t => now - t < 3600000);
    if(recent.length >= 5){ showToast('You have made several bookings in the last hour. Please try again later.', 'error'); if(nb()) nb().disabled = false; return; }
    recent.push(now); localStorage.setItem('aura_bookings', JSON.stringify(recent));
  } catch(e) { /* private mode: skip the limit */ }
  addAppointment(biz.id, {
    customerName: st.name, customerPhone: st.phone, customerEmail: st.email || '',
    serviceId: svc.id, serviceName: svc.name, price: svc.price,
    date: st.date, time: st.time, status: 'pending'
  }).then(()=>{
    if(st.email) sendEmail(st.email, st.name, 'Booking request sent to '+biz.name, 'Hi '+st.name+', your request for '+svc.name+' at '+biz.name+' on '+prettyWhen(st.date, st.time)+' has been sent. '+biz.name+' will confirm it shortly and you will get another email when they do.');
    st.step = 'success';
    renderBookingStep();
  }).catch(err=>{
    console.error('Booking failed', err);
    if(err && err.code === 'permission-denied'){
      showToast('Sorry, that time was just taken. Please choose another time.', 'error');
      st.time = ''; st.step = 3; renderBookingStep();
      return;
    }
    showToast('Could not submit your booking — check your internet connection', 'error');
    if(nb()) nb().disabled = false;
  });
}

/* ---------------------------------------------------------------------
   15. LOGIN / SIGNUP  (auth.js)
   --------------------------------------------------------------------- */
function setFieldError(fieldId, invalid){
  const el = document.getElementById(fieldId);
  if(el) el.classList.toggle('invalid', invalid);
}
function validEmailOrPhone(v){ return validEmail(v); }
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); }
function validPhone(v){ const t = String(v||'').trim(); const d = t.replace(/\D/g,''); return /^[0-9+\s()-]+$/.test(t) && d.length >= 9 && d.length <= 12; }

document.getElementById('login-form').addEventListener('submit', function(e){
  e.preventDefault();
  const id = document.getElementById('login-id').value.trim();
  const pw = document.getElementById('login-pw').value;
  let ok = true;
  if(!validEmailOrPhone(id)){ setFieldError('f-login-id', true); ok = false; } else setFieldError('f-login-id', false);
  if(pw.trim().length < 1){ setFieldError('f-login-pw', true); ok = false; } else setFieldError('f-login-pw', false);
  if(!ok) return;

  const submitBtn = this.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = 'Logging in…';

  const remember = !!(document.getElementById('login-remember') || {}).checked;
  auth.setPersistence(remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION)
    .catch(() => {})
    .then(() => auth.signInWithEmailAndPassword(id, pw)).then(cred => {
    // onAuthStateChanged sets currentAuthUser/role; wait for the cache so we
    // know whether this account is admin or linked to a business.
    whenCacheReady(() => {
      const isAdmin = cred.user.uid === ADMIN_UID;
      const biz = isAdmin ? null : getBusinesses().find(b => b.ownerUid === cred.user.uid);
      if(!isAdmin && !biz){
        auth.signOut();
        showToast("This account isn't linked to a business. Contact the admin.", 'error');
        return;
      }
      showToast('Welcome back' + (isAdmin ? '' : ', ' + biz.name) + '!');
      navigate(isAdmin ? 'admin' : 'dashboard');
    });
  }).catch(err => {
    console.error('Login failed', err);
    const msg = ['auth/wrong-password','auth/user-not-found','auth/invalid-credential','auth/invalid-email'].includes(err.code)
      ? 'Incorrect email or password.'
      : err.code === 'auth/too-many-requests'
        ? 'Too many attempts — please wait a moment and try again.'
        : 'Could not log in — check your internet connection.';
    setFieldError('f-login-pw', true);
    showToast(msg, 'error');
  }).finally(()=>{
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  });
});

document.querySelectorAll('.pw-toggle').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const input = document.getElementById(btn.getAttribute('data-target'));
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
});


/* ---- Connect Google to the account you are already logged into (guaranteed link, same account) ---- */
document.addEventListener('click', function(e){
  const btn = e.target.closest('#link-google-btn');
  if(!btn) return;
  const cu = auth.currentUser;
  if(!cu) return;
  btn.disabled = true;
  // linkWithPopup is called straight from the tap so phone browsers don't block the window
  cu.linkWithPopup(new firebase.auth.GoogleAuthProvider()).then(() => {
    showToast('Google connected. You can now log in with Google.');
    renderRoute();
  }).catch(err => {
    console.error('Google link failed', err);
    if(['auth/popup-closed-by-user','auth/cancelled-popup-request','auth/user-cancelled'].includes(err.code)) return;
    const msgs = {
      'auth/credential-already-in-use': 'That Google account is already connected to another Aura account.',
      'auth/provider-already-linked': 'Google is already connected to this account.',
      'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
      'auth/operation-not-allowed': 'Google sign-in is not switched on yet. Please contact us.',
      'auth/unauthorized-domain': 'This web address is not approved for Google sign-in yet. Please contact us.',
      'auth/network-request-failed': 'Could not reach Google - check your internet connection.'
    };
    showToast(msgs[err.code] || ('Could not connect Google (' + (err.code || err.message || 'unknown') + '). Please try again.'), 'error');
  }).finally(() => { btn.disabled = false; });
});

/* ---- Sign in with Google ----
   Role rules are unchanged: a Google account only gets in if its Firebase uid is the admin or is
   linked to a business (Firebase links Google to an existing password account with the same email). */
function applyPersistence(){
  const remember = !!(document.getElementById('login-remember') || {}).checked;
  return auth.setPersistence(remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION).catch(() => {});
}
(function wireGoogleSignIn(){
  const btn = document.getElementById('google-signin-btn');
  const remember = document.getElementById('login-remember');
  if(remember) remember.addEventListener('change', applyPersistence);
  applyPersistence();
  if(!btn) return;
  btn.addEventListener('click', function(){
    if(/FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok|musical_ly/i.test(navigator.userAgent)){
      showToast('Google blocks sign-in inside this app. Open this page in Chrome or Safari and try again.', 'error'); return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    btn.disabled = true;
    // signInWithPopup is called straight from the tap so phone browsers don't block the window
    auth.signInWithPopup(provider).then(cred => {
      whenCacheReady(() => {
        const isAdmin = cred.user.uid === ADMIN_UID;
        const biz = isAdmin ? null : getBusinesses().find(b => b.ownerUid === cred.user.uid);
        if(!isAdmin && !biz) return; // the auth listener signs out and explains
        showToast('Welcome back' + (isAdmin ? '' : ', ' + biz.name) + '!');
        navigate(isAdmin ? 'admin' : 'dashboard');
      });
    }).catch(err => {
      console.error('Google sign-in failed', err);
      const quiet = ['auth/popup-closed-by-user','auth/cancelled-popup-request','auth/user-cancelled'];
      if(quiet.includes(err.code)) return;
      const msgs = {
        'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
        'auth/operation-not-allowed': 'Google sign-in is not switched on yet. Please contact us.',
        'auth/unauthorized-domain': 'This web address is not approved for Google sign-in yet. Please contact us.',
        'auth/network-request-failed': 'Could not reach Google - check your internet connection.',
        'auth/web-storage-unsupported': 'Your browser is blocking cookies or storage. Turn off tracking protection for this site, or try Chrome.',
        'auth/operation-not-supported-in-this-environment': 'Google sign-in needs the site opened from a web address (http or https), not a file.',
        'auth/account-exists-with-different-credential': 'This email already has a password account. Log in with your password, then open Settings and tap Connect Google.'
      };
      showToast(msgs[err.code] || ('Google sign-in failed (' + (err.code || err.message || 'unknown') + '). Please try again.'), 'error');
    }).finally(() => { btn.disabled = false; });
  });
})();

document.getElementById('forgot-pw-link').addEventListener('click', (e)=>{
  e.preventDefault();
  const email = document.getElementById('login-id').value.trim();
  if(!validEmail(email)){ setFieldError('f-login-id', true); showToast('Enter your email address above, then tap "Forgot password?"', 'error'); return; }
  setFieldError('f-login-id', false);
  auth.sendPasswordResetEmail(email)
    .then(() => showToast('If an account exists for that email, a reset link is on its way.'))
    .catch(err => {
      console.error('Password reset failed', err);
      showToast(err.code === 'auth/too-many-requests' ? 'Too many attempts — please wait a moment and try again.' : 'If an account exists for that email, a reset link is on its way.', err.code === 'auth/too-many-requests' ? 'error' : 'success');
    });
});

/* ---------------------------------------------------------------------
   16. BUSINESS DASHBOARD  (dashboard.js)
   --------------------------------------------------------------------- */
const DASH_NAV = [
  {key:'overview', label:'Overview', icon:ICON.home},
  {key:'profile', label:'My Business', icon:ICON.store},
  {key:'services', label:'Services', icon:ICON.scissors},
  {key:'appointments', label:'Appointments', icon:ICON.calendar},
  {key:'customers', label:'Customers', icon:ICON.users},
  {key:'staff', label:'Staff', icon:ICON.users, feature:'staff'},
  {key:'analytics', label:'Analytics', icon:ICON.chart, feature:'analytics'},
  {key:'subscription', label:'Subscription', icon:ICON.card},
  {key:'settings', label:'Settings', icon:ICON.gear}
];
const DASH_TITLES = { overview:'Overview', profile:'My Business', services:'Services', appointments:'Appointments', customers:'Customers', staff:'Staff', analytics:'Analytics', subscription:'Subscription', settings:'Settings' };

function currentBiz(){
  const user = getCurrentUser();
  if(!user || !user.businessId) return getBusinesses()[0];
  return getBusiness(user.businessId) || getBusinesses()[0];
}

function renderDashboard(section){
  section = DASH_TITLES[section] ? section : 'overview';
  AppState.dashSection = section;
  const biz = currentBiz();
  const user = getCurrentUser();

  if(!biz){
    document.getElementById('dash-title').textContent = 'Loading…';
    document.getElementById('dash-content').innerHTML = '<p class="text-muted">Loading your business…</p>';
    return;
  }
  ensureAppointmentsListener(biz.id); ensureBusyListener(biz.id);

  document.getElementById('dash-title').textContent = DASH_TITLES[section];
  document.getElementById('sidebar-plan-label').textContent = PLANS[biz.plan].label;
  document.getElementById('dash-avatar').textContent = (user && user.name ? user.name[0] : biz.name[0]).toUpperCase();

  const nav = document.getElementById('dash-sidenav');
  nav.innerHTML = DASH_NAV.map(item=>{
    const locked = item.feature && !checkFeatureAccess(item.feature, biz.plan);
    return `<div class="side-link ${AppState.dashSection===item.key?'active':''} ${locked?'locked':''}" data-dash="${item.key}">
      <span class="ic">${item.icon}</span>${item.label}${locked?'<span class="lock-ic">'+ICON.lock+'</span>':''}
    </div>`;
  }).join('');

  nav.querySelectorAll('[data-dash]').forEach(el=>{
    el.addEventListener('click', ()=> navigate('dashboard/'+el.getAttribute('data-dash')));
  });

  const content = document.getElementById('dash-content');
  if(section === 'overview') content.innerHTML = renderDashOverview(biz);
  else if(section === 'profile') content.innerHTML = renderDashProfile(biz);
  else if(section === 'services') content.innerHTML = renderDashServices(biz);
  else if(section === 'appointments') content.innerHTML = renderDashAppointments(biz);
  else if(section === 'customers') content.innerHTML = renderDashCustomers(biz);
  else if(section === 'staff') content.innerHTML = checkFeatureAccess('staff', biz.plan) ? renderDashStaff(biz) : renderLockedFeature('Staff management', 'pro');
  else if(section === 'analytics') content.innerHTML = checkFeatureAccess('analytics', biz.plan) ? renderDashAnalytics(biz) : renderLockedFeature('Analytics', 'pro');
  else if(section === 'subscription') content.innerHTML = renderDashSubscription(biz);
  else if(section === 'settings') content.innerHTML = renderDashSettings(biz);

  if(isSuspended(biz)){
    const msg = 'Hi, my business ' + biz.name + ' (' + biz.id + ') on Aura is suspended. Please help me get it reinstated.';
    content.insertAdjacentHTML('afterbegin', '<div class="suspend-banner"><b>Your business is suspended.</b> Your page is hidden from customers and bookings are switched off. <a href="https://wa.me/254115506649?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener">Message us on WhatsApp</a> to get reinstated.</div>');
  }

  wireDashSectionEvents(section, biz);
}

document.addEventListener('click', e=>{ const el = e.target.closest('#dash-content [data-dash]'); if(el) navigate('dashboard/'+el.getAttribute('data-dash')); });
document.querySelector('.sidebar-footer [data-dash="upgrade"]')?.addEventListener('click', ()=>navigate('dashboard/subscription'));
document.getElementById('dash-logout').addEventListener('click', ()=>{ logoutUser(); navigate('home'); showToast('Logged out'); });
document.getElementById('dash-hamburger').addEventListener('click', ()=>{
  document.getElementById('dash-sidebar').classList.add('open');
  document.getElementById('sidebar-backdrop').classList.add('open');
});
document.getElementById('sidebar-backdrop').addEventListener('click', ()=>{
  document.getElementById('dash-sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('open');
});

function renderLockedFeature(name, minPlan){
  return `
    <div class="locked-card">
      <div class="ico">${ICON.lock}</div>
      <h3>${esc(name)} is available on ${PLANS[minPlan].label}</h3>
      <p>Upgrade your plan to unlock this feature for your business.</p>
      <button class="btn btn-primary" data-dash="subscription">View ${PLANS[minPlan].label}</button>
    </div>
  `;
}

/* ---- Overview ---- */
function profileCompleteness(biz){
  let score = 0, total = 6, tips = [];
  if(biz.description && biz.description.length>20) score++; else tips.push('Write a description of your business');
  if(biz.services && biz.services.length>0) score++; else tips.push('Add at least one service');
  if(biz.gallery && biz.gallery.length>=3) score++; else tips.push('Add 3 more photos');
  if(biz.whatsapp) score++; else tips.push('Add a WhatsApp contact number');
  if(biz.socialLinks && Object.keys(biz.socialLinks).length>0) score++; else tips.push('Add your social links');
  if(biz.location && biz.location !== 'Kenya') score++; else tips.push('Add your exact location');
  return { pct: Math.round((score/total)*100), tips };
}

function renderDashOverview(biz){
  const today = localISO();
  const todaysAppts = (biz.appointments||[]).filter(a=>a.date===today && a.status!=='cancelled').sort((a,b)=>a.time<b.time?-1:1);
  const totalBookings = (biz.appointments||[]).length;
  const thisMonth = localISO().slice(0,7);
  const monthBookings = (biz.appointments||[]).filter(a=>a.date.startsWith(thisMonth)).length;
  const revenue = (biz.appointments||[]).filter(a=>a.status==='completed').reduce((s,a)=>s+(a.price||0),0);
  const completion = profileCompleteness(biz);

  return `
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Total bookings</div><div class="value">${totalBookings}</div></div>
      <div class="stat-card"><div class="label">Today's bookings</div><div class="value">${esc(todaysAppts.length)}</div></div>
      <div class="stat-card"><div class="label">This month</div><div class="value">${monthBookings}</div></div>
      <div class="stat-card"><div class="label">Estimated revenue</div><div class="value">${fmtKsh(revenue)}</div><div class="delta">From completed bookings</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Today's appointments</h3><span class="text-muted" style="font-size:13px;">${new Date().toLocaleDateString('en-US',{weekday:'long', day:'numeric', month:'long'})}</span></div>
      ${todaysAppts.length ? todaysAppts.map(a=>`
        <div class="appt-row">
          <div class="appt-time">${to12h(a.time)}</div>
          <div class="appt-who"><b>${esc(a.customerName)}</b><span>${esc(a.serviceName)}</span></div>
          <span class="badge badge-${esc(a.status)}">${esc(a.status)}</span>
        </div>
      `).join('') : `<div class="empty-state"><div class="ico">${ICON.calendar}</div><h4>No appointments yet</h4><p>Your upcoming bookings will appear here.</p></div>`}
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Business profile completion</h3><b>${esc(completion.pct)}% complete</b></div>
      <div class="progress-bar"><div class="fill" style="width:${esc(completion.pct)}%"></div></div>
      ${completion.tips.slice(0,3).map(t=>`<div class="suggestion-item">${ICON.bulb} ${t}</div>`).join('') || '<div class="suggestion-item">Your profile looks complete!</div>'}
      <button class="btn btn-outline btn-sm mt16" data-dash="profile">Complete your profile</button>
    </div>
  `;
}

/* ---- My Business (profile editor) ---- */
function renderDashProfile(biz){
  const photoLimit = PLANS[biz.plan].limits.photos;
  return `
    <div class="panel">
      <div class="panel-head"><h3>Branding</h3></div>
      <div style="display:flex; gap:28px; flex-wrap:wrap;">
        <div>
          <h5 style="font-size:12.5px;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.03em;">Logo</h5>
          <div class="brand-preview-logo" style="${logoStyle(biz)}"></div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm" id="change-logo-btn">Change logo</button>
            ${biz.logoImage ? `<button class="btn btn-ghost btn-sm" id="reset-logo-btn">Reset to default</button>` : ''}
          </div>
          <input type="file" id="logo-file-input" accept="image/*" style="display:none">
        </div>
        <div style="flex:1;min-width:240px;">
          <h5 style="font-size:12.5px;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.03em;">Cover photo</h5>
          <div class="brand-preview-cover" style="${coverStyle(biz)}"></div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm" id="change-cover-btn">Change cover photo</button>
            ${biz.coverImage ? `<button class="btn btn-ghost btn-sm" id="reset-cover-btn">Reset to default</button>` : ''}
          </div>
          <input type="file" id="cover-file-input" accept="image/*" style="display:none">
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Business details</h3></div>
      <div class="field"><label>Business name</label><input id="edit-biz-name" value="${escapeAttr(biz.name)}"></div>
      <div class="form-row-2">
        <div class="field"><label>Category</label>
          <select id="edit-biz-cat">
            ${['Barbershop','Salon','Spa','Nail studio','Massage','Other'].map(c=>`<option ${biz.category===c?'selected':''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Location</label><input id="edit-biz-location" value="${escapeAttr(biz.location)}"></div>
      </div>
      <div class="field"><label>Description</label><textarea id="edit-biz-desc">${escapeAttr(biz.description)}</textarea></div>
      <div class="field"><label>WhatsApp number (e.g. 0712345678)</label><input id="edit-biz-whatsapp" value="${escapeAttr(biz.whatsapp||'')}" placeholder="07XXXXXXXX"></div>
      <button class="btn btn-primary" id="save-profile-btn">Save changes</button>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Share your page</h3></div>
      <p class="text-muted" style="font-size:13.5px;margin-bottom:14px;">Every plan gets a working link — share it on WhatsApp, Instagram or TikTok so customers can find you.</p>
      <div class="field"><label>Your page link</label><input id="share-link-input" value="${esc(getShareLink(biz.id))}" readonly></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-outline btn-sm" id="copy-share-link-btn">${ICON.copy} Copy link</button>
        <a class="btn btn-outline btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('Check out '+biz.name+' on Aura: '+getShareLink(biz.id))}">${ICON.chat} Share on WhatsApp</a>
      </div>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:18px;">
        <div id="share-qr" style="background:#fff;padding:10px;border-radius:12px;line-height:0;min-width:200px;min-height:200px;"></div>
        <div style="flex:1;min-width:200px;"><b>Your QR code</b><p class="text-muted" style="font-size:13px;margin:6px 0 12px;">Print it and put it on your counter, mirror or door. Customers scan it to open your page and book.</p><button class="btn btn-outline btn-sm" id="download-qr-btn">Download QR poster</button></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Photo gallery</h3><span class="text-muted" style="font-size:13px;">${(biz.gallery||[]).length} / ${photoLimit===999?'Unlimited':photoLimit}</span></div>
      <div class="gallery-grid">
        ${(biz.gallery||[]).map((c,i)=> safeImgUrl(c) ? `<div class="g" style="position:relative;background-image:url('${esc(safeImgUrl(c))}');background-size:cover;background-position:center;">
          <button class="btn btn-icon btn-danger btn-sm" style="position:absolute;top:6px;right:6px;width:26px;height:26px;" data-remove-photo="${i}">✕</button>
        </div>` : `<div class="g" style="background:${safeColor(c)};position:relative;">
          <button class="btn btn-icon btn-danger btn-sm" style="position:absolute;top:6px;right:6px;width:26px;height:26px;" data-remove-photo="${i}">✕</button>
        </div>`).join('')}
        ${(biz.gallery||[]).length < photoLimit ? `<button class="g" id="add-photo-btn" style="background:var(--paper-sunken);border:1px dashed var(--line-strong);display:flex;align-items:center;justify-content:center;font-size:22px;color:var(--muted);cursor:pointer;">+</button>` : ''}
      </div>
      <input type="file" id="photo-file-input" accept="image/*" style="display:none">
      ${(biz.gallery||[]).length >= photoLimit ? `<p class="text-muted mt16" style="font-size:13px;">Photo limit reached for the ${PLANS[biz.plan].label} plan. <a href="#dashboard/subscription" data-nav="dashboard" style="color:var(--accent-ink);font-weight:600;" onclick="setTimeout(()=>navigate('dashboard/subscription'))">Upgrade</a> to add more.</p>` : ''}
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Opening hours</h3></div>
      ${(biz.hours||[]).map((h,i)=>`
        <div class="hours-row" style="align-items:center;">
          <span style="width:100px;">${esc(h.day)}</span>
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="time" value="${esc(h.open==='Closed'?'':h.open)}" data-hour-open="${i}" style="border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;background:var(--paper);color:var(--ink);" ${h.open==='Closed'?'disabled':''}>
            <span class="text-muted">to</span>
            <input type="time" value="${esc(h.close==='Closed'?'':h.close)}" data-hour-close="${i}" style="border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;background:var(--paper);color:var(--ink);" ${h.close==='Closed'?'disabled':''}>
            <label style="display:flex;align-items:center;gap:5px;font-size:12.5px;"><input type="checkbox" data-hour-closed="${i}" ${h.open==='Closed'?'checked':''}> Closed</label>
          </div>
        </div>
      `).join('')}
      <button class="btn btn-primary btn-sm mt16" id="save-hours-btn">Save hours</button>
    </div>

    ${checkFeatureAccess('customUrl', biz.plan) ? `
    <div class="panel">
      <div class="panel-head"><h3>Custom business URL</h3></div>
      <p class="text-muted" style="font-size:13.5px;">Custom links are coming soon. Until then, share your page link from the panel above.</p>
    </div>` : `
    <div class="panel">
      <div class="panel-head"><h3>Custom business URL</h3></div>
      <p class="text-muted" style="font-size:13.5px;">Available on Starter plan and above. <a href="#" style="color:var(--accent-ink);font-weight:600;" onclick="navigate('dashboard/subscription');return false;">Upgrade to unlock</a>.</p>
    </div>`}
  `;
}
function escapeAttr(s){ return esc(s); }

/* ---- Share link (works for every plan — the auto-generated page link) ---- */
function renderShareQr(biz){
  const box = document.getElementById('share-qr'); if(!box) return;
  if(!window.QRCode){ box.style.lineHeight = '1.4'; box.textContent = 'QR code could not load. Check your internet connection.'; return; }
  const link = getShareLink(biz.id);
  box.innerHTML = ''; new QRCode(box, { text:link, width:180, height:180, correctLevel:QRCode.CorrectLevel.M });
  document.getElementById('download-qr-btn').onclick = () => {
    const big = document.createElement('div'); new QRCode(big, { text:link, width:800, height:800, correctLevel:QRCode.CorrectLevel.M });
    const src = big.querySelector('canvas'); if(!src) return;
    const c = document.createElement('canvas'); c.width = 960; c.height = 1080; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0,0,960,1080); x.drawImage(src, 80, 80, 800, 800);
    x.textAlign = 'center'; x.fillStyle = '#0D1B2A'; x.font = 'bold 44px sans-serif'; x.fillText(biz.name, 480, 950, 860);
    x.fillStyle = '#555'; x.font = '30px sans-serif'; x.fillText('Scan to view services and book', 480, 1010);
    const a = document.createElement('a'); a.download = slugify(biz.name) + '-qr.png'; a.href = c.toDataURL('image/png'); a.click();
  };
}
function getShareLink(bizId){
  return window.location.origin + window.location.pathname + '#business?id=' + bizId;
}
function copyToClipboard(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=> showToast('Link copied!')).catch(()=> fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text){
  try{
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Link copied!');
  }catch(e){
    showToast('Could not copy automatically — please copy the link manually', 'error');
  }
}

/* ---- Real photo uploads: read the chosen file, downscale it so it stays
   small enough for localStorage, and return a data URL ---- */
function isImageSrc(v){ return !!safeImgUrl(v); }
function resizeImageFile(file, maxDim, quality){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      const img = new Image();
      img.src = reader.result;

      const draw = () => {
        try{
          let { naturalWidth: width, naturalHeight: height } = img;
          if(!width || !height){ reject(new Error('Could not read that image')); return; }
          if(width > maxDim || height > maxDim){
            if(width > height){ height = Math.round(height * (maxDim / width)); width = maxDim; }
            else { width = Math.round(width * (maxDim / height)); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          // Fill white first: JPEG has no alpha channel, so any untouched/transparent
          // canvas area would otherwise export as solid black instead of the photo.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        }catch(err){ reject(err); }
      };

      // img.decode() guarantees the image is fully rasterized before we draw it —
      // some browsers can fire the older `onload` event a moment too early, which
      // is the classic cause of a canvas export coming out solid black.
      if(img.decode){
        img.decode().then(draw).catch(()=>{
          img.onload = draw;
          img.onerror = ()=> reject(new Error('Could not read that image'));
        });
      } else {
        img.onload = draw;
        img.onerror = ()=> reject(new Error('Could not read that image'));
      }
    };
    reader.onerror = ()=> reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

const CLOUDINARY = { cloud:'dbk47jrff', preset:'' }; // set preset to an UNSIGNED upload preset to store photos on Cloudinary
function uploadImage(file, maxDim, quality){
  return resizeImageFile(file, maxDim, quality).then(dataUrl => {
    if(!CLOUDINARY.preset) return dataUrl;
    const fd = new FormData(); fd.append('file', dataUrl); fd.append('upload_preset', CLOUDINARY.preset);
    return fetch('https://api.cloudinary.com/v1_1/'+CLOUDINARY.cloud+'/image/upload', { method:'POST', body:fd }).then(r => r.json()).then(j => { if(!j.secure_url) throw new Error('Upload failed'); return j.secure_url; });
  });
}

/* ---- Services management ---- */
function renderDashServices(biz){
  const limit = PLANS[biz.plan].limits.services;
  const atLimit = (biz.services||[]).length >= limit;
  return `
    <div class="panel">
      <div class="panel-head">
        <h3>Your services <span class="text-muted" style="font-weight:400;font-size:13px;">(${(biz.services||[]).length}/${limit===999?'∞':limit})</span></h3>
        <button class="btn btn-primary btn-sm" id="add-service-btn" ${atLimit?'disabled':''}>+ Add service</button>
      </div>
      ${atLimit ? `<p class="text-muted" style="font-size:13px;margin-bottom:14px;">You've reached the service limit for the ${PLANS[biz.plan].label} plan. <a href="#" onclick="navigate('dashboard/subscription');return false;" style="color:var(--accent-ink);font-weight:600;">Upgrade</a> to add more.</p>` : ''}
      ${(biz.services||[]).length ? biz.services.map(s=>`
        <div class="service-row">
          <div class="sinfo"><h4>${esc(s.name)}</h4><p>${esc(s.description||'')}</p><div class="dur">⏱ ${esc(s.duration)} min</div></div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="sprice">${fmtKsh(s.price)}</span>
            <div class="row-actions">
              <button class="btn btn-outline btn-sm" data-edit-service="${esc(s.id)}">Edit</button>
              <button class="btn btn-danger btn-sm" data-delete-service="${esc(s.id)}">Delete</button>
            </div>
          </div>
        </div>
      `).join('') : `<div class="empty-state"><div class="ico">${ICON.scissors}</div><h4>No services yet</h4><p>Add your first service to start showing prices to customers.</p></div>`}
    </div>
  `;
}

function serviceFormModal(biz, service){
  const isEdit = !!service;
  return `
    <div class="modal-head"><h3>${isEdit?'Edit service':'Add service'}</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body service-form-modal">
      <div class="field"><label>Service name</label><input id="svc-name" value="${escapeAttr(service?service.name:'')}" placeholder="e.g. Haircut"></div>
      <div class="field"><label>Description</label><textarea id="svc-desc" placeholder="Briefly describe this service">${escapeAttr(service?service.description:'')}</textarea></div>
      <div class="form-row-2">
        <div class="field"><label>Price (KSh)</label><input type="number" id="svc-price" value="${esc(service?service.price:'')}" min="0"></div>
        <div class="field"><label>Duration (minutes)</label><input type="number" id="svc-duration" value="${esc(service?service.duration:'')}" min="5"></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="save-service-btn">${isEdit?'Save changes':'Add service'}</button>
    </div>
  `;
}

function wireServicesSection(biz){
  const addBtn = document.getElementById('add-service-btn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    openModal(serviceFormModal(biz, null));
    document.getElementById('save-service-btn').addEventListener('click', ()=>{
      const name = document.getElementById('svc-name').value.trim();
      const price = Number(document.getElementById('svc-price').value);
      const duration = Number(document.getElementById('svc-duration').value);
      if(!name || !price || !duration){ showToast('Please fill in all required fields', 'error'); return; }
      const fresh = getBusiness(biz.id);
      fresh.services = fresh.services || [];
      fresh.services.push({ id:'s'+Date.now(), name, description: document.getElementById('svc-desc').value.trim(), price, duration });
      saveBusiness(fresh);
      closeModal(); showToast('Service added'); renderDashboard('services');
    });
  });

  document.querySelectorAll('[data-edit-service]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const svc = biz.services.find(s=>s.id===btn.getAttribute('data-edit-service'));
      openModal(serviceFormModal(biz, svc));
      document.getElementById('save-service-btn').addEventListener('click', ()=>{
        const name = document.getElementById('svc-name').value.trim();
        const price = Number(document.getElementById('svc-price').value);
        const duration = Number(document.getElementById('svc-duration').value);
        if(!name || !price || !duration){ showToast('Please fill in all required fields', 'error'); return; }
        const fresh = getBusiness(biz.id);
        const target = fresh.services.find(s=>s.id===svc.id);
        Object.assign(target, { name, description: document.getElementById('svc-desc').value.trim(), price, duration });
        saveBusiness(fresh);
        closeModal(); showToast('Service updated'); renderDashboard('services');
      });
    });
  });

  document.querySelectorAll('[data-delete-service]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-delete-service');
      openModal(confirmModal('Delete this service?', 'This cannot be undone.', ()=>{
        const fresh = getBusiness(biz.id);
        fresh.services = fresh.services.filter(s=>s.id!==id);
        saveBusiness(fresh);
        closeModal(); showToast('Service deleted'); renderDashboard('services');
      }));
    });
  });
}

function confirmModal(title, body, onConfirm){
  const html = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><p class="text-muted">${body}</p></div>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-danger" id="confirm-yes-btn">Confirm</button></div>
  `;
  setTimeout(()=>{ const btn = document.getElementById('confirm-yes-btn'); if(btn) btn.addEventListener('click', onConfirm); }, 0);
  return html;
}

/* ---- Appointment management ---- */
const APPT_TABS = [
  {key:'upcoming', label:'Upcoming'},
  {key:'today', label:'Today'},
  {key:'completed', label:'Completed'},
  {key:'cancelled', label:'Cancelled'}
];
let apptActiveTab = 'upcoming';

function filterAppointments(biz, tab){
  const today = localISO();
  const list = biz.appointments || [];
  if(tab === 'today') return list.filter(a=>a.date===today && a.status!=='cancelled');
  if(tab === 'upcoming') return list.filter(a=> (a.date>=today || a.status==='pending') && (a.status==='pending'||a.status==='upcoming'||a.status==='confirmed'));
  if(tab === 'completed') return list.filter(a=>a.status==='completed');
  if(tab === 'cancelled') return list.filter(a=>a.status==='cancelled');
  return list;
}

function renderDashAppointments(biz){
  if(!checkFeatureAccess('booking', biz.plan)){
    return renderLockedFeature('Appointment management', 'business');
  }
  const list = filterAppointments(biz, apptActiveTab).sort((a,b)=> (a.date+a.time) < (b.date+b.time) ? -1:1);
  return `
    <div class="tab-bar">
      ${APPT_TABS.map(t=>`<button class="tab-btn ${apptActiveTab===t.key?'active':''}" data-appt-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div class="panel">
      ${list.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Customer</th><th>Service</th><th>Date</th><th>Time</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${list.map(a=>`
            <tr>
              <td>${esc(a.customerName)}</td>
              <td>${esc(a.serviceName)}</td>
              <td>${new Date(a.date+'T00:00:00').toLocaleDateString('en-US',{day:'numeric',month:'short'})}</td>
              <td>${to12h(a.time)}</td>
              <td>${esc(a.customerPhone||'—')}</td>
              <td><span class="badge badge-${esc(a.status==='upcoming'?'pending':a.status)}">${esc(a.status)}</span></td>
              <td><div class="row-actions">${apptActionButtons(a, biz)}</div></td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state"><div class="ico">${ICON.calendar}</div><h4>No appointments here yet</h4><p>Your upcoming bookings will appear here.</p></div>`}
    </div>
  `;
}

/* The business's own WhatsApp number, as wa.me digits. Never falls back to the platform number. */
function bizWaDigits(biz){ return waNumber(biz && biz.whatsapp) || String((biz && biz.whatsapp) || '').replace(/\D/g,''); }
/* Kenyan number -> international digits for wa.me (0712345678, +254712345678, 712345678 -> 254712345678). '' if invalid. */
function waNumber(raw){
  let d = String(raw || '').replace(/\D/g, '');
  if(d.startsWith('0')) d = '254' + d.slice(1);
  else if(d.length === 9) d = '254' + d;
  return /^254\d{9}$/.test(d) ? d : '';
}
/* A calendar file the customer can tap to save the appointment on their phone. */
function buildIcs(biz, svc, st){
  const pad = n => String(n).padStart(2,'0');
  const t = x => String(x||'').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
  const [y,m,d] = st.date.split('-').map(Number), [hh,mm] = st.time.split(':').map(Number);
  const start = new Date(y, m-1, d, hh, mm);
  const end = new Date(start.getTime() + (parseInt(svc.duration,10) || 60) * 60000);
  const f = dt => dt.getFullYear() + pad(dt.getMonth()+1) + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + pad(dt.getMinutes()) + '00';
  return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Aura//Booking//EN','BEGIN:VEVENT',
    'UID:' + Date.now() + '-' + biz.id + '@aura',
    'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z',
    'DTSTART:' + f(start), 'DTEND:' + f(end),
    'SUMMARY:' + t((svc.name || 'Appointment') + ' at ' + biz.name),
    'LOCATION:' + t(biz.location),
    'DESCRIPTION:' + t('Booked on Aura. The business will confirm your appointment.'),
    'END:VEVENT','END:VCALENDAR'].join('\r\n');
}

function confirmWaLink(biz, a){
  const num = waNumber(a.customerPhone);
  if(!num) return '';
  const when = new Date(a.date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long', day:'numeric', month:'long' }) + ' at ' + to12h(a.time);
  const first = String(a.customerName || '').trim().split(/\s+/)[0] || 'there';
  const approved = a.status === 'upcoming' || a.status === 'confirmed';
  const msg = approved
    ? 'Hi ' + first + ', your appointment at ' + biz.name + ' is confirmed: ' + a.serviceName + ' on ' + when + '. See you then! Reply here if you need to change it.'
    : 'Hi ' + first + ', this is ' + biz.name + '. We received your booking for ' + a.serviceName + ' on ' + when + '. Is that time still good for you? Please reply YES to confirm, or tell us a better time.';
  return 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg);
}
function waConfirmButton(a, biz){
  if(!biz || !checkFeatureAccess('whatsappConfirm', biz.plan)) return '';
  const link = confirmWaLink(biz, a);
  if(!link) return '';
  const approved = a.status === 'upcoming' || a.status === 'confirmed';
  const label = approved ? 'Send approval' : 'Confirm on WhatsApp';
  return `<a class="btn btn-sm ${approved ? 'btn-accent' : 'btn-outline'}" target="_blank" rel="noopener" href="${esc(link)}">${ICON.chat} ${label}</a>`;
}
function apptActionButtons(a, biz){
  if(a.status==='pending') return waConfirmButton(a, biz) + `<button class="btn btn-sm btn-primary" data-appt-action="accept:${esc(a.id)}">Accept</button><button class="btn btn-sm btn-danger" data-appt-action="reject:${esc(a.id)}">Reject</button>`;
  if(a.status==='upcoming' || a.status==='confirmed') return waConfirmButton(a, biz) + `<button class="btn btn-sm btn-outline" data-appt-action="complete:${esc(a.id)}">Complete</button><button class="btn btn-sm btn-danger" data-appt-action="cancel:${esc(a.id)}">Cancel</button>`;
  return `<span class="text-muted" style="font-size:12.5px;">—</span>`;
}

function wireAppointmentsSection(biz){
  document.querySelectorAll('[data-appt-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ apptActiveTab = btn.getAttribute('data-appt-tab'); renderDashboard('appointments'); });
  });
  document.querySelectorAll('[data-appt-action]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const [action, id] = btn.getAttribute('data-appt-action').split(':');
      const map = { accept:'upcoming', reject:'cancelled', complete:'completed', cancel:'cancelled' };
      updateAppointmentStatus(biz.id, id, map[action]).then(()=>{
        showToast('Appointment ' + (action==='accept'?'accepted':action==='reject'?'rejected':action==='complete'?'marked complete':'cancelled'));
      });
    });
  });
}

/* ---- Customers ---- */
function renderDashCustomers(biz){
  const map = {};
  (biz.appointments||[]).forEach(a=>{
    if(!map[a.customerPhone||a.customerName]) map[a.customerPhone||a.customerName] = { name:a.customerName, phone:a.customerPhone, visits:0, lastDate:a.date, spent:0 };
    const c = map[a.customerPhone||a.customerName];
    c.visits++;
    if(a.date > c.lastDate) c.lastDate = a.date;
    if(a.status==='completed') c.spent += (a.price||0);
  });
  const customers = Object.values(map).sort((a,b)=>b.visits-a.visits);
  if(!checkFeatureAccess('booking', biz.plan)) return renderLockedFeature('Customer management', 'business');
  return `
    <div class="panel">
      <div class="panel-head"><h3>Customers <span class="text-muted" style="font-weight:400;font-size:13px;">(${esc(customers.length)})</span></h3></div>
      ${customers.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Name</th><th>Phone</th><th>Visits</th><th>Last visit</th><th>Total spent</th></tr></thead>
        <tbody>${customers.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.phone||'—')}</td><td>${esc(c.visits)}</td><td>${new Date(c.lastDate+'T00:00:00').toLocaleDateString('en-US',{day:'numeric',month:'short'})}</td><td>${fmtKsh(c.spent)}</td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty-state"><div class="ico">${ICON.users}</div><h4>No customers yet</h4><p>Customers will show up here once they book with you.</p></div>`}
    </div>
  `;
}

/* ---- Staff management (Pro only) ---- */
function renderDashStaff(biz){
  return `
    <div class="panel">
      <div class="panel-head"><h3>Staff members</h3><button class="btn btn-primary btn-sm" id="add-staff-btn">+ Add staff</button></div>
      ${(biz.staff||[]).length ? biz.staff.map(s=>`
        <div class="staff-card">
          <div class="staff-avatar">${esc(s.name[0])}</div>
          <div class="staff-info"><b>${esc(s.name)}</b><span>${esc(s.role)} · ${(s.services||[]).length} services assigned</span></div>
          <span class="status-dot ${s.active?'on':'off'}" title="${s.active?'Active':'Inactive'}"></span>
          <div class="row-actions">
            <button class="btn btn-outline btn-sm" data-toggle-staff="${esc(s.id)}">${s.active?'Deactivate':'Activate'}</button>
            <button class="btn btn-danger btn-sm" data-delete-staff="${esc(s.id)}">Remove</button>
          </div>
        </div>
      `).join('') : `<div class="empty-state"><div class="ico">${ICON.users}</div><h4>No staff added yet</h4><p>Add team members to assign them to appointments.</p></div>`}
    </div>
  `;
}

function staffFormModal(biz){
  return `
    <div class="modal-head"><h3>Add staff member</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Name</label><input id="staff-name" placeholder="e.g. Kevin Wafula"></div>
      <div class="field"><label>Role</label><input id="staff-role" placeholder="e.g. Barber"></div>
      <div class="field"><label>Assign services</label>
        ${(biz.services||[]).map(s=>`<label style="display:flex;align-items:center;gap:8px;font-size:13.5px;padding:6px 0;"><input type="checkbox" value="${esc(s.id)}" class="staff-svc-check"> ${esc(s.name)}</label>`).join('') || '<p class="text-muted" style="font-size:13px;">Add services first to assign them.</p>'}
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="save-staff-btn">Add staff</button></div>
  `;
}

function wireStaffSection(biz){
  const addBtn = document.getElementById('add-staff-btn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    openModal(staffFormModal(biz));
    document.getElementById('save-staff-btn').addEventListener('click', ()=>{
      const name = document.getElementById('staff-name').value.trim();
      const role = document.getElementById('staff-role').value.trim();
      const services = Array.from(document.querySelectorAll('.staff-svc-check:checked')).map(c=>c.value);
      if(!name || !role){ showToast('Please enter a name and role', 'error'); return; }
      const fresh = getBusiness(biz.id);
      fresh.staff = fresh.staff || [];
      fresh.staff.push({ id:'st'+Date.now(), name, role, active:true, services });
      saveBusiness(fresh);
      closeModal(); showToast('Staff member added'); renderDashboard('staff');
    });
  });
  document.querySelectorAll('[data-toggle-staff]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const fresh = getBusiness(biz.id);
      const s = fresh.staff.find(x=>x.id===btn.getAttribute('data-toggle-staff'));
      s.active = !s.active; saveBusiness(fresh); renderDashboard('staff');
    });
  });
  document.querySelectorAll('[data-delete-staff]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-delete-staff');
      openModal(confirmModal('Remove this staff member?', 'This cannot be undone.', ()=>{
        const fresh = getBusiness(biz.id);
        fresh.staff = fresh.staff.filter(s=>s.id!==id);
        saveBusiness(fresh); closeModal(); showToast('Staff removed'); renderDashboard('staff');
      }));
    });
  });
}

/* ---- Analytics (Pro only) ---- */
function renderDashAnalytics(biz){
  const appts = biz.appointments || [];
  const today = new Date();
  const weekLabels = [], weekCounts = [];
  for(let i=6;i>=0;i--){
    const d = new Date(); d.setDate(today.getDate()-i);
    const iso = localISO(d);
    weekLabels.push(d.toLocaleDateString('en-US',{weekday:'short'}));
    weekCounts.push(appts.filter(a=>a.date===iso).length);
  }
  const maxCount = Math.max(1, ...weekCounts);

  const svcCounts = {};
  appts.forEach(a=>{ svcCounts[a.serviceName] = (svcCounts[a.serviceName]||0)+1; });
  const popularServices = Object.entries(svcCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const colors = ['#FF9F1C','#0D1B2A','#2F6F8F','#1F8A5B','#B8A98A'];

  const monthRevenue = appts.filter(a=>a.status==='completed').reduce((s,a)=>s+(a.price||0),0);
  const uniqueCustomers = new Set(appts.map(a=>a.customerPhone||a.customerName));
  const thisMonth = localISO().slice(0,7);
  const newThisMonth = new Set(appts.filter(a=>a.date.startsWith(thisMonth)).map(a=>a.customerPhone||a.customerName)).size;

  return `
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Bookings this week</div><div class="value">${weekCounts.reduce((a,b)=>a+b,0)}</div></div>
      <div class="stat-card"><div class="label">Bookings this month</div><div class="value">${appts.filter(a=>a.date.startsWith(thisMonth)).length}</div></div>
      <div class="stat-card"><div class="label">Estimated revenue</div><div class="value">${fmtKsh(monthRevenue)}</div></div>
      <div class="stat-card"><div class="label">New customers</div><div class="value">${newThisMonth}</div><div class="delta">${esc(uniqueCustomers.size)} total customers</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Bookings — last 7 days</h3></div>
      <div class="bar-chart">
        ${weekCounts.map((c,i)=>`<div class="bar-col"><div class="bar" style="height:${(c/maxCount)*100}%"></div><div class="bar-label">${weekLabels[i]}</div></div>`).join('')}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Popular services</h3></div>
      ${popularServices.length ? `<div class="donut-legend">${popularServices.map(([name,count],i)=>`<div class="li"><span class="sw" style="background:${colors[i]}"></span>${esc(name)} <span class="text-muted">— ${esc(count)} bookings</span></div>`).join('')}</div>` : `<p class="text-muted" style="font-size:13.5px;">Not enough data yet.</p>`}
    </div>
  `;
}

/* ---------------------------------------------------------------------
   17. SUBSCRIPTION  (subscription.js)
   Fields modelled so a real payment provider (e.g. M-Pesa) can later
   populate paymentProvider / transactionId and flip status to 'active'.
   --------------------------------------------------------------------- */
function renderDashSubscription(biz){
  const sub = biz.subscription || {plan:biz.plan};
  const plan = PLANS[sub.plan];
  return `
    <div class="panel">
      <div class="panel-head"><h3>Current plan</h3></div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;">
        <div>
          <div style="font-family:var(--font-display);font-size:24px;font-weight:700;">${plan.label}</div>
          <div class="text-muted" style="font-size:13.5px;margin-top:4px;">
            ${sub.plan==='free' ? 'No expiry — free forever' : `${sub.billingCycle==='yearly'?'Billed yearly':'Billed monthly'} · renews ${esc(sub.expiryDate||'—')}`}
          </div>
        </div>
        <span class="badge badge-confirmed" style="text-transform:capitalize;">${esc(sub.status||'active')}</span>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Choose a plan</h3></div>
      <div class="pricing-grid dash-plans">
        ${PLAN_ORDER.map(pid=>{
          const p = PLANS[pid];
          const isCurrent = pid === sub.plan;
          return `
          <div class="price-card ${pid==='business'?'popular':''}">
            ${pid==='business'?'<span class="popular-tag">Most Popular</span>':''}
            <h3>${p.label}</h3>
            <div class="price-amount"><span class="num">${fmtKsh(p.price.monthly)}</span><span class="per">${pid==='free'?'':'/month'}</span></div>
            <ul class="price-features">${pricingBullets(pid).slice(0,3).map(b=>`<li><span class="ck">✓</span>${esc(b)}</li>`).join('')}</ul>
            <button class="btn ${isCurrent?'btn-outline':'btn-primary'} btn-block" ${isCurrent?'disabled':''} data-choose-plan="${pid}">${isCurrent?'Current plan':(planRank(pid)>planRank(sub.plan)?'Upgrade':'Switch')}</button>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>Billing details</h3></div>
      <p class="text-muted" style="font-size:13.5px;line-height:1.7;">
        Aura does not process real payments yet. When M-Pesa is connected, invoices and payment history will appear here automatically —
        the subscription record already stores <code>plan</code>, <code>status</code>, <code>billingCycle</code>, <code>startDate</code>, <code>expiryDate</code>,
        <code>paymentProvider</code> and <code>transactionId</code> so the switch-over needs no redesign.
      </p>
    </div>
  `;
}

function wireSubscriptionSection(biz){
  document.querySelectorAll('[data-choose-plan]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const targetPlan = btn.getAttribute('data-choose-plan');
      if(targetPlan === 'free'){
        openModal(confirmModal('Switch to Free plan?', 'You will lose access to features not included in Free. Our team makes the change once you confirm on WhatsApp.', ()=>{
          const msg = 'Hi, I\'d like to switch ' + biz.name + ' (' + biz.id + ') to the Free plan.';
          window.open('https://wa.me/254115506649?text=' + encodeURIComponent(msg), '_blank', 'noopener');
          closeModal(); showToast('Opening WhatsApp...');
        }));
        return;
      }
      openModal(upgradeFlowModal(biz, targetPlan));
      wireUpgradeModal(biz);
    });
  });
}

function upgradeFlowModal(biz, targetPlan, cycle){
  cycle = cycle || 'monthly';
  const plan = PLANS[targetPlan];
  const price = plan.price[cycle];
  return `
    <div class="modal-head"><h3>Upgrade to ${plan.label}</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="plan-select-row">
        <div class="plan-select-opt ${cycle==='monthly'?'selected':''}" data-cycle="monthly"><span>Monthly</span><b>${fmtKsh(plan.price.monthly)}/mo</b></div>
        <div class="plan-select-opt ${cycle==='yearly'?'selected':''}" data-cycle="yearly"><span>Yearly</span><b>${fmtKsh(plan.price.yearly)}/yr</b></div>
      </div>
      <div class="summary-row"><span>Plan</span><span>${plan.label}</span></div>
      <div class="summary-row"><span>Billing cycle</span><span style="text-transform:capitalize;">${cycle}</span></div>
      <div class="summary-row"><span>Total due</span><span>${fmtKsh(price)}</span></div>
      <p class="text-muted" style="font-size:12.5px;margin-top:14px;">Your plan is activated by our team once payment is confirmed.</p>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-accent" id="confirm-upgrade-btn" data-plan="${targetPlan}" data-cycle="${cycle}">Request upgrade on WhatsApp</button>
    </div>
  `;
}

function wireUpgradeModal(biz){
  document.querySelectorAll('.plan-select-opt').forEach(opt=>{
    opt.addEventListener('click', ()=>{
      const cycle = opt.getAttribute('data-cycle');
      const targetPlan = document.getElementById('confirm-upgrade-btn').getAttribute('data-plan');
      openModal(upgradeFlowModal(biz, targetPlan, cycle));
      wireUpgradeModal(biz);
    });
  });
  const simBtn = document.getElementById('confirm-upgrade-btn');
  if(simBtn) simBtn.addEventListener('click', ()=>{
    const targetPlan = simBtn.getAttribute('data-plan');
    const cycle = simBtn.getAttribute('data-cycle');
    const msg = 'Hi, I\'d like to upgrade ' + biz.name + ' (' + biz.id + ') to the ' + PLANS[targetPlan].label + ' plan, billed ' + cycle + ' (' + fmtKsh(PLANS[targetPlan].price[cycle]) + ').';
    window.open('https://wa.me/254115506649?text=' + encodeURIComponent(msg), '_blank', 'noopener');
    closeModal();
    showToast('Opening WhatsApp — your plan is activated once payment is confirmed.');
  });
}

/* ---- Settings ---- */
function googleLinkedEmail(){
  const cu = auth.currentUser;
  const p = cu && (cu.providerData || []).find(x => x && x.providerId === 'google.com');
  return p ? (p.email || 'connected') : '';
}

function renderDashSettings(biz){
  const user = getCurrentUser();
  const gEmail = googleLinkedEmail();
  return `
    <div class="panel settings-section">
      <div class="panel-head"><h3>Account</h3></div>
      <div class="settings-row"><div class="stxt"><b>Name</b><span>${esc(user?user.name:'Owner')}</span></div><button class="btn btn-outline btn-sm" data-toast="Editing your name isn't available yet.">Edit</button></div>
      <div class="settings-row"><div class="stxt"><b>Email</b><span>${esc(user?user.email:'—')}</span></div><button class="btn btn-outline btn-sm" data-toast="Editing your email isn't available yet.">Edit</button></div>
      <div class="settings-row"><div class="stxt"><b>Google sign-in</b><span>${gEmail ? 'Connected: ' + esc(gEmail) : 'Not connected. Connect it to log in with one tap.'}</span></div>${gEmail ? '<span class="badge badge-completed">Connected</span>' : '<button class="btn btn-outline btn-sm" id="link-google-btn">Connect Google</button>'}</div>
      <div class="settings-row"><div class="stxt"><b>Password</b><span>••••••••</span></div><button class="btn btn-outline btn-sm" data-toast="Password changes aren't available yet.">Change</button></div>
    </div>
    <div class="panel settings-section">
      <div class="panel-head"><h3>Preferences</h3></div>
      <div class="settings-row"><div class="stxt"><b>Booking notifications</b><span>Show a banner for new pending bookings</span></div><div class="toggle-switch on" data-toast="Notification preferences aren't available yet."><div class="knob"></div></div></div>
    </div>
    <div class="panel settings-section">
      <div class="panel-head"><h3>Danger zone</h3></div>
      <div class="settings-row"><div class="stxt"><b>Delete business</b><span>Permanently remove your business page</span></div><button class="btn btn-danger btn-sm" data-toast="Deleting a business isn't available yet.">Delete</button></div>
    </div>
  `;
}

/* ---------------------------------------------------------------------
   18. DASHBOARD EVENT DISPATCH
   --------------------------------------------------------------------- */
function wireDashSectionEvents(section, biz){
  if(section === 'services') wireServicesSection(biz);
  if(section === 'appointments') wireAppointmentsSection(biz);
  if(section === 'staff') wireStaffSection(biz);
  if(section === 'subscription') wireSubscriptionSection(biz);

  if(section === 'profile'){
    const saveBtn = document.getElementById('save-profile-btn');
    if(saveBtn) saveBtn.addEventListener('click', ()=>{
      const fresh = getBusiness(biz.id);
      fresh.name = document.getElementById('edit-biz-name').value.trim() || fresh.name;
      fresh.category = document.getElementById('edit-biz-cat').value;
      fresh.location = document.getElementById('edit-biz-location').value.trim();
      fresh.description = document.getElementById('edit-biz-desc').value.trim();
      { const rawWa = document.getElementById('edit-biz-whatsapp').value.trim(); fresh.whatsapp = waNumber(rawWa) || rawWa.replace(/^\+/,''); }
      saveBusiness(fresh); showToast('Business profile saved'); renderDashboard('profile');
    });
    { const qb = currentBiz(); if(qb) renderShareQr(qb); }
    const copyLinkBtn = document.getElementById('copy-share-link-btn');
    if(copyLinkBtn) copyLinkBtn.addEventListener('click', ()=>{
      copyToClipboard(document.getElementById('share-link-input').value);
    });

    const changeLogoBtn = document.getElementById('change-logo-btn');
    const logoFileInput = document.getElementById('logo-file-input');
    if(changeLogoBtn && logoFileInput){
      changeLogoBtn.addEventListener('click', ()=> logoFileInput.click());
      logoFileInput.addEventListener('change', (e)=>{
        const file = e.target.files && e.target.files[0];
        if(!file) return;
        if(!file.type.startsWith('image/')){ showToast('Please choose an image file', 'error'); logoFileInput.value=''; return; }
        uploadImage(file, 500, 0.85).then(dataUrl=>{
          const fresh = getBusiness(biz.id);
          fresh.logoImage = dataUrl;
          saveBusiness(fresh);
          showToast('Logo updated');
          renderDashboard('profile');
        }).catch(err=>{
          console.error(err);
          showToast('Could not process that image', 'error');
        }).finally(()=>{ logoFileInput.value = ''; });
      });
    }
    const resetLogoBtn = document.getElementById('reset-logo-btn');
    if(resetLogoBtn) resetLogoBtn.addEventListener('click', ()=>{
      const fresh = getBusiness(biz.id);
      delete fresh.logoImage;
      saveBusiness(fresh); showToast('Logo reset to default'); renderDashboard('profile');
    });

    const changeCoverBtn = document.getElementById('change-cover-btn');
    const coverFileInput = document.getElementById('cover-file-input');
    if(changeCoverBtn && coverFileInput){
      changeCoverBtn.addEventListener('click', ()=> coverFileInput.click());
      coverFileInput.addEventListener('change', (e)=>{
        const file = e.target.files && e.target.files[0];
        if(!file) return;
        if(!file.type.startsWith('image/')){ showToast('Please choose an image file', 'error'); coverFileInput.value=''; return; }
        uploadImage(file, 1200, 0.8).then(dataUrl=>{
          const fresh = getBusiness(biz.id);
          fresh.coverImage = dataUrl;
          saveBusiness(fresh);
          showToast('Cover photo updated');
          renderDashboard('profile');
        }).catch(err=>{
          console.error(err);
          showToast('Could not process that image', 'error');
        }).finally(()=>{ coverFileInput.value = ''; });
      });
    }
    const resetCoverBtn = document.getElementById('reset-cover-btn');
    if(resetCoverBtn) resetCoverBtn.addEventListener('click', ()=>{
      const fresh = getBusiness(biz.id);
      delete fresh.coverImage;
      saveBusiness(fresh); showToast('Cover photo reset to default'); renderDashboard('profile');
    });

    const addPhotoBtn = document.getElementById('add-photo-btn');
    const photoFileInput = document.getElementById('photo-file-input');
    if(addPhotoBtn && photoFileInput){
      addPhotoBtn.addEventListener('click', ()=> photoFileInput.click());
      photoFileInput.addEventListener('change', (e)=>{
        const file = e.target.files && e.target.files[0];
        if(!file) return;
        if(!file.type.startsWith('image/')){ showToast('Please choose an image file', 'error'); photoFileInput.value=''; return; }
        uploadImage(file, 900, 0.75).then(dataUrl=>{
          const fresh = getBusiness(biz.id);
          fresh.gallery = fresh.gallery || [];
          fresh.gallery.push(dataUrl);
          saveBusiness(fresh);
          showToast('Photo uploaded');
          renderDashboard('profile');
        }).catch(err=>{
          console.error(err);
          showToast('Could not process that image', 'error');
        }).finally(()=>{ photoFileInput.value = ''; });
      });
    }
    document.querySelectorAll('[data-remove-photo]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const idx = Number(btn.getAttribute('data-remove-photo'));
        const fresh = getBusiness(biz.id);
        fresh.gallery.splice(idx,1); saveBusiness(fresh); renderDashboard('profile');
      });
    });
    const saveHoursBtn = document.getElementById('save-hours-btn');
    if(saveHoursBtn) saveHoursBtn.addEventListener('click', ()=>{
      const fresh = getBusiness(biz.id);
      fresh.hours.forEach((h,i)=>{
        const closedBox = document.querySelector(`[data-hour-closed="${i}"]`);
        if(closedBox && closedBox.checked){ h.open='Closed'; h.close='Closed'; return; }
        const openInput = document.querySelector(`[data-hour-open="${i}"]`);
        const closeInput = document.querySelector(`[data-hour-close="${i}"]`);
        if(openInput && openInput.value) h.open = openInput.value;
        if(closeInput && closeInput.value) h.close = closeInput.value;
      });
      saveBusiness(fresh); showToast('Opening hours saved'); renderDashboard('profile');
    });
  }

  if(section === 'settings'){
    document.querySelectorAll('[data-toast]').forEach(el=>{
      el.addEventListener('click', ()=> showToast(el.getAttribute('data-toast')));
    });
  }
}

/* ---------------------------------------------------------------------
   19. ADMIN DASHBOARD
   --------------------------------------------------------------------- */
const ADMIN_NAV = [
  {key:'overview', label:'Platform overview', icon:ICON.home},
  {key:'applications', label:'Applications', icon:ICON.users},
  {key:'businesses', label:'Businesses', icon:ICON.store}
];
const ADMIN_TITLES = { overview:'Platform overview', applications:'Applications', businesses:'Businesses' };
let adminSearch = '', adminPlanFilter = 'All', adminStatusFilter = 'All';

/* Owner emails live in businesses/{id}/private/owner (admin-only). Older businesses still have the
   email in the public document; the first time the admin opens the Businesses list it is moved. */
const adminOwnerEmails = {}, adminEmailsTried = {};
function adminLoadOwnerEmails(){
  const u = auth.currentUser;
  if(!u || u.uid !== ADMIN_UID) return;
  const todo = getBusinesses().filter(b => !adminEmailsTried[b.id]);
  if(!todo.length) return;
  todo.forEach(b => { adminEmailsTried[b.id] = true; });
  Promise.all(todo.map(b => {
    const ref = db.collection('businesses').doc(b.id);
    return ref.collection('private').doc('owner').get().then(d => {
      if(d.exists){ adminOwnerEmails[b.id] = d.data().ownerEmail; return; }
      if(b.ownerEmail){
        adminOwnerEmails[b.id] = b.ownerEmail;
        const batch = db.batch();
        batch.set(ref.collection('private').doc('owner'), { ownerEmail: b.ownerEmail });
        batch.update(ref, { ownerEmail: firebase.firestore.FieldValue.delete() });
        return batch.commit();
      }
    }).catch(err => console.error('Owner email lookup failed', err));
  })).then(() => refreshRoute());
}

function renderAdmin(section){
  section = ADMIN_TITLES[section] ? section : 'overview';
  AppState.adminSection = section;
  document.getElementById('admin-title').textContent = ADMIN_TITLES[section];

  const nav = document.getElementById('admin-sidenav');
  nav.innerHTML = ADMIN_NAV.map(item=>`<div class="side-link ${section===item.key?'active':''}" data-admin-nav="${item.key}"><span class="ic">${item.icon}</span>${item.label}${item.key==='applications' && pendingApps() ? `<span class="nav-badge">${pendingApps()}</span>` : ''}</div>`).join('');
  nav.querySelectorAll('[data-admin-nav]').forEach(el=> el.addEventListener('click', ()=> navigate('admin/'+el.getAttribute('data-admin-nav'))));

  const content = document.getElementById('admin-content');
  content.innerHTML = section === 'overview' ? renderAdminOverview() : section === 'applications' ? renderAdminApplications() : renderAdminBusinesses();
  if(section === 'businesses') adminLoadOwnerEmails();
  if(section === 'overview') getBusinesses().forEach(b => ensureAppointmentsListener(b.id));
  wireAdminSectionEvents(section);
}

document.getElementById('admin-hamburger').addEventListener('click', ()=>{
  document.getElementById('admin-sidebar').classList.add('open');
  document.getElementById('admin-sidebar-backdrop').classList.add('open');
});
document.getElementById('admin-sidebar-backdrop').addEventListener('click', ()=>{
  document.getElementById('admin-sidebar').classList.remove('open');
  document.getElementById('admin-sidebar-backdrop').classList.remove('open');
});

function renderAdminOverview(){
  const businesses = getBusinesses();
  const byPlan = { free:0, starter:0, business:0, pro:0 };
  businesses.forEach(b=> byPlan[b.plan] = (byPlan[b.plan]||0)+1 );
  const activeSubs = businesses.filter(b=>b.plan!=='free').length;
  const totalBookings = businesses.reduce((s,b)=>s+((b.appointments||[]).length),0);
  const thisMonth = localISO().slice(0,7);
  const newRegistrations = businesses.filter(b=>b.joined && b.joined.startsWith(thisMonth)).length;

  return `
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Total businesses</div><div class="value">${esc(businesses.length)}</div></div>
      <div class="stat-card"><div class="label">Active paid subscriptions</div><div class="value">${activeSubs}</div></div>
      <div class="stat-card"><div class="label">Total bookings</div><div class="value">${totalBookings}</div></div>
      <div class="stat-card"><div class="label">New registrations (this month)</div><div class="value">${newRegistrations}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Businesses by plan</h3></div>
      <div class="stat-grid" style="margin-bottom:0;">
        ${PLAN_ORDER.map(pid=>`<div class="stat-card"><div class="label">${PLANS[pid].label}</div><div class="value">${byPlan[pid]||0}</div></div>`).join('')}
      </div>
    </div>
  `;
}

function renderAdminBusinesses(){
  const all = getBusinesses();
  const list = all.filter(b=>{
    const matchQ = !adminSearch || b.name.toLowerCase().includes(adminSearch.toLowerCase());
    const matchPlan = adminPlanFilter === 'All' || b.plan === adminPlanFilter.toLowerCase();
    return matchQ && matchPlan;
  });
  return `
    <div class="panel">
      <div class="panel-head">
        <h3>All businesses <span class="text-muted" style="font-weight:400;font-size:13px;">(${esc(list.length)})</span></h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <input type="text" id="admin-search-input" placeholder="Search businesses..." value="${escapeAttr(adminSearch)}" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line-strong);background:var(--paper);color:var(--ink);font-size:13.5px;">
          <select id="admin-plan-filter" style="padding:9px 12px;border-radius:8px;border:1px solid var(--line-strong);background:var(--paper);color:var(--ink);font-size:13.5px;">
            ${['All','Free','Starter','Business','Pro'].map(p=>`<option ${adminPlanFilter===p?'selected':''}>${esc(p)}</option>`).join('')}
          </select>
          <button class="btn btn-primary btn-sm" id="admin-add-business-btn">+ Add business</button>
        </div>
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Business</th><th>Owner email</th><th>Category</th><th>Plan</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
        <tbody>
          ${list.map(b=>`
            <tr>
              <td><b>${esc(b.name)}</b></td>
              <td>${esc(adminOwnerEmails[b.id] || b.ownerEmail || '—')}</td>
              <td>${esc(b.category)}</td>
              <td style="text-transform:capitalize;">${esc(b.plan)}</td>
              <td><span class="badge badge-confirmed" style="text-transform:capitalize;">${esc((b.subscription&&b.subscription.status)||'active')}</span></td>
              <td>${b.joined ? new Date(b.joined+'T00:00:00').toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
              <td><div class="row-actions">
                <select class="plan-select" data-admin-plan="${esc(b.id)}" aria-label="Change plan for ${esc(b.name)}">${PLAN_ORDER.map(p=>`<option value="${p}" ${b.plan===p?'selected':''}>${esc(PLANS[p].label)}</option>`).join('')}</select>
                <button class="btn btn-outline btn-sm" data-admin-view="${esc(b.id)}">View</button>
                <button class="btn btn-danger btn-sm" data-admin-suspend="${esc(b.id)}">${(b.subscription&&b.subscription.status)==='suspended'?'Reinstate':'Suspend'}</button>
              </div></td>
            </tr>
          `).join('')}
        </tbody>
      </table></div>
      ${!list.length ? `<div class="empty-state"><div class="ico">${ICON.search}</div><h4>No businesses match</h4></div>` : ''}
    </div>
  `;
}

function wireAdminSectionEvents(section){
  if(section === 'applications'){ wireAdminApplications(); return; }
  if(section !== 'businesses') return;
  const searchInput = document.getElementById('admin-search-input');
  if(searchInput) searchInput.addEventListener('input', ()=>{ adminSearch = searchInput.value; renderAdmin('businesses'); searchInput.focus(); searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); });
  const planFilter = document.getElementById('admin-plan-filter');
  if(planFilter) planFilter.addEventListener('change', ()=>{ adminPlanFilter = planFilter.value; renderAdmin('businesses'); });
  const addBtn = document.getElementById('admin-add-business-btn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    openModal(adminAddBusinessModal());
    wireAdminAddBusinessModal();
  });
  document.querySelectorAll('[data-admin-view]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ navigate('business?id='+btn.getAttribute('data-admin-view')); });
  });
  document.querySelectorAll('[data-admin-plan]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const fresh = getBusiness(sel.getAttribute('data-admin-plan'));
      const plan = sel.value;
      if(!fresh || !PLANS[plan]) return;
      const prev = fresh.subscription || {};
      const cycle = plan === 'free' ? null : (prev.billingCycle || 'monthly');
      const start = new Date(); const expiry = new Date(start);
      if(plan !== 'free') expiry.setMonth(expiry.getMonth() + (cycle === 'yearly' ? 12 : 1));
      fresh.plan = plan;
      fresh.subscription = { plan, status: prev.status || 'active', billingCycle: cycle, startDate: localISO(start), expiryDate: plan === 'free' ? null : localISO(expiry), paymentProvider: prev.paymentProvider || null, transactionId: prev.transactionId || null };
      saveBusiness(fresh);
      showToast(fresh.name + ' is now on the ' + PLANS[plan].label + ' plan');
      renderAdmin('businesses');
    });
  });
  document.querySelectorAll('[data-admin-suspend]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const fresh = getBusiness(btn.getAttribute('data-admin-suspend'));
      if(fresh && !isSuspended(fresh) && !window.confirm('Suspend ' + fresh.name + '? Their page will be hidden from customers and bookings will be switched off.')) return;
      fresh.subscription = fresh.subscription || {};
      fresh.subscription.status = fresh.subscription.status === 'suspended' ? 'active' : 'suspended';
      saveBusiness(fresh);
      showToast('Business ' + (fresh.subscription.status === 'suspended' ? 'suspended' : 'reinstated'));
      renderAdmin('businesses');
    });
  });
}

/* ---- Admin: add a business directly onto a chosen plan ---- */
function adminAddBusinessModal(){
  return `
    <div class="modal-head"><h3>Add a business</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Business name</label><input id="ab-name" placeholder="e.g. Neat Cuts Barbershop"></div>
      <div class="form-row-2">
        <div class="field"><label>Category</label>
          <select id="ab-category">
            ${['Barbershop','Salon','Spa','Nail studio','Massage','Other'].map(c=>`<option>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Location</label><input id="ab-location" placeholder="e.g. Kisii, Kenya"></div>
      </div>
      <div class="field" id="f-ab-owner-email">
        <label>Owner email</label>
        <input id="ab-owner-email" type="email" placeholder="owner@example.com">
        <div class="err">Enter a valid, unused email — this is what the owner logs in with.</div>
      </div>
      <div class="field" id="f-ab-owner-password">
        <label>Temporary password</label>
        <input id="ab-owner-password" type="text" placeholder="At least 6 characters">
        <div class="err">Password must be at least 6 characters.</div>
      </div>
      <p class="text-muted" style="font-size:12px;margin:-10px 0 16px;">Share this email and password with the owner — they'll use it to log in. They can't change it themselves yet, so pick something you can read back to them.</p>
      <div class="field"><label>Plan</label>
        <select id="ab-plan">
          ${PLAN_ORDER.map(pid=>`<option value="${pid}">${PLANS[pid].label} — ${fmtKsh(PLANS[pid].price.monthly)}/mo</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="admin-save-business-btn">Add business</button>
    </div>
  `;
}

function wireAdminAddBusinessModal(){
  document.getElementById('admin-save-business-btn').addEventListener('click', ()=>{
    const saveBtn = document.getElementById('admin-save-business-btn');
    const name = document.getElementById('ab-name').value.trim();
    const category = document.getElementById('ab-category').value;
    const location = document.getElementById('ab-location').value.trim() || 'Kenya';
    const plan = document.getElementById('ab-plan').value;
    const ownerEmail = document.getElementById('ab-owner-email').value.trim().toLowerCase();
    const ownerPassword = document.getElementById('ab-owner-password').value;

    if(!name){ showToast('Please enter a business name', 'error'); return; }
    const emailTaken = getBusinesses().some(b => (b.ownerEmail||'').toLowerCase() === ownerEmail) || Object.values(adminOwnerEmails).some(e => (e||'').toLowerCase() === ownerEmail);
    let ok = true;
    if(!validEmail(ownerEmail) || isAdminEmail(ownerEmail) || emailTaken){
      setFieldError('f-ab-owner-email', true);
      showToast(emailTaken ? 'That owner email is already in use by another business' : 'Please enter a valid, unused owner email', 'error');
      ok = false;
    } else setFieldError('f-ab-owner-email', false);
    if(ownerPassword.length < 6){
      setFieldError('f-ab-owner-password', true);
      ok = false;
    } else setFieldError('f-ab-owner-password', false);
    if(!ok) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating account…';

    createOwnerAccount(ownerEmail, ownerPassword).then(ownerUid => {
      const bizId = slugify(name) + '-' + Math.floor(Math.random()*900+100);
      const start = new Date();
      const newBiz = {
        id: bizId, name, category, emoji: categoryEmoji(category), ownerUid,
        location, description: 'Tell customers about this business — edit it from the business dashboard.',
        rating:0, reviewCount:0, priceFrom:0,
        coverColor:'linear-gradient(135deg,#1B3550,#0D1B2A)', logoColor:'#FF9F1C',
        whatsapp:'', socialLinks:{},
        plan: plan,
        subscription: {
          plan: plan, status:'active', billingCycle: plan==='free' ? null : 'monthly',
          startDate: localISO(start),
          expiryDate: plan==='free' ? null : localISO(new Date(start.getFullYear(), start.getMonth()+1, start.getDate())),
          paymentProvider: null, transactionId: null
        },
        hours:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d=>({day:d, open:'09:00', close:'18:00'})),
        gallery:[], services:[], reviews:[], staff:[],
        joined: localISO(start)
      };
      const bizRef = db.collection('businesses').doc(bizId);
      const createBatch = db.batch();
      createBatch.set(bizRef, newBiz);
      createBatch.set(bizRef.collection('private').doc('owner'), { ownerEmail }); // never public
      adminOwnerEmails[bizId] = ownerEmail;
      return createBatch.commit().then(()=>{
        closeModal();
        showToast('Business added on the ' + PLANS[plan].label + ' plan — owner logs in with ' + ownerEmail);
        adminSearch = ''; adminPlanFilter = 'All';
        renderAdmin('businesses');
      });
    }).catch(err => {
      console.error('Could not create owner account', err);
      const msg = err.code === 'auth/email-already-in-use'
        ? 'That email already has a login account — use a different email.'
        : err.code === 'auth/weak-password'
          ? 'Password is too weak — use at least 6 characters.'
          : 'Could not create the account — check your internet connection.';
      showToast(msg, 'error');
    }).finally(()=>{
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add business';
    });
  });
}

/* ---------------------------------------------------------------------
   20. MOBILE NAV + MISC GLOBAL WIRING
   --------------------------------------------------------------------- */
/* SELF-REGISTRATION: owners apply, the admin approves.
   applications/{id}: public create, admin-only read/update/delete (see firestore.rules). */
let applications = [], applicationsUnsub = null;
function pendingApps(){ return applications.filter(a => a.status === 'pending').length; }
function startApplicationsListener(){
  if(applicationsUnsub) return;
  applicationsUnsub = db.collection('applications').onSnapshot(snap => {
    applications = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    refreshRoute();
  }, err => console.error('Applications listener error', err));
}
function stopApplicationsListener(){ if(applicationsUnsub){ applicationsUnsub(); applicationsUnsub = null; } applications = []; }

function renderRegister(params){
  const sel = document.getElementById('reg-plan');
  if(!sel.options.length) sel.innerHTML = PLAN_ORDER.map(p => `<option value="${p}">${esc(PLANS[p].label)}${p==='free' ? '' : ' — '+fmtKsh(PLANS[p].price.monthly)+'/mo'}</option>`).join('');
  const p = params.get('plan') || '';
  if(sel.dataset.p !== p){ sel.dataset.p = p; if(PLANS[p]) sel.value = p; }
}
document.getElementById('register-form').addEventListener('submit', function(e){
  e.preventDefault();
  const v = id => document.getElementById(id).value.trim();
  const d = { businessName:v('reg-name'), category:v('reg-category'), location:v('reg-location'), ownerName:v('reg-owner'), whatsapp:v('reg-phone'), ownerEmail:v('reg-email').toLowerCase(), description:v('reg-desc'), plan:v('reg-plan') };
  const checks = { 'f-reg-name': d.businessName.length > 1, 'f-reg-location': d.location.length > 1, 'f-reg-owner': d.ownerName.length > 1, 'f-reg-phone': validPhone(d.whatsapp), 'f-reg-email': validEmail(d.ownerEmail) };
  let ok = true; Object.keys(checks).forEach(k => { setFieldError(k, !checks[k]); if(!checks[k]) ok = false; });
  if(!ok) return;
  const done = () => { this.style.display = 'none'; document.getElementById('register-done').style.display = 'block'; window.scrollTo({top:0, behavior:'instant'}); };
  if(document.getElementById('reg-website').value){ done(); return; }
  try {
    const now = Date.now(), recent = JSON.parse(localStorage.getItem('aura_apps') || '[]').filter(t => now - t < 86400000);
    if(recent.length >= 3){ showToast('You have already sent several applications today. We will be in touch.', 'error'); return; }
    recent.push(now); localStorage.setItem('aura_apps', JSON.stringify(recent));
  } catch(err) {}
  const btn = this.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Sending…';
  db.collection('applications').add({ ...d, whatsapp: waNumber(d.whatsapp) || d.whatsapp, status:'pending', createdAt:new Date().toISOString() })
    .then(done)
    .catch(err => { console.error('Application failed', err); showToast('Could not send your application. Check your connection and try again.', 'error'); })
    .finally(() => { btn.disabled = false; btn.textContent = 'Submit application'; });
});

function renderAdminApplications(){
  const list = applications.slice().sort((a,b) => (b.createdAt||'') < (a.createdAt||'') ? -1 : 1);
  const card = a => `<div class="service-row"><div class="sinfo"><h4>${esc(a.businessName)} <span class="price-tag">${esc(a.category)}</span></h4><p>${esc(a.location)} · ${esc(a.ownerName)} · ${esc(a.whatsapp)} · ${esc(a.ownerEmail)}</p><p>${esc(a.description || 'No description given')}</p><div class="dur">Asked for ${esc((PLANS[a.plan] || PLANS.free).label)} · ${esc((a.createdAt||'').slice(0,10))}</div></div><div class="row-actions">${a.status === 'pending' ? `<button class="btn btn-primary btn-sm" data-app-approve="${esc(a.id)}">Approve</button><button class="btn btn-danger btn-sm" data-app-reject="${esc(a.id)}">Reject</button>` : `<span class="badge badge-${a.status==='approved' ? 'confirmed' : 'cancelled'}">${esc(a.status)}</span><button class="btn btn-ghost btn-sm" data-app-delete="${esc(a.id)}">Remove</button>`}</div></div>`;
  return `<div class="panel"><div class="panel-head"><h3>Applications <span class="text-muted" style="font-weight:400;font-size:13px;">(${pendingApps()} waiting)</span></h3></div>${list.length ? list.map(card).join('') : `<div class="empty-state"><div class="ico">${ICON.users}</div><h4>No applications yet</h4><p>When someone applies from the List Your Business page, it shows up here.</p></div>`}</div>`;
}
function wireAdminApplications(){
  const find = id => applications.find(a => a.id === id);
  document.querySelectorAll('[data-app-approve]').forEach(b => b.addEventListener('click', () => {
    const a = find(b.getAttribute('data-app-approve')); if(!a) return;
    openModal(`<div class="modal-head"><h3>Approve ${esc(a.businessName)}</h3><button class="modal-close" onclick="closeModal()">✕</button></div><div class="modal-body"><p class="text-muted" style="font-size:13.5px;margin-bottom:14px;">This creates the owner's login (${esc(a.ownerEmail)}) and publishes the page. They get an email to set their own password. Only start someone on a paid plan after payment is confirmed.</p><div class="field"><label>Start on plan</label><select id="approve-plan">${PLAN_ORDER.map(p => `<option value="${p}">${esc(PLANS[p].label)}</option>`).join('')}</select></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="approve-confirm-btn">Approve and create account</button></div>`);
    document.getElementById('approve-confirm-btn').addEventListener('click', () => approveApplication(a, document.getElementById('approve-plan').value));
  }));
  document.querySelectorAll('[data-app-reject]').forEach(b => b.addEventListener('click', () => {
    db.collection('applications').doc(b.getAttribute('data-app-reject')).update({ status:'rejected', reviewedAt:localISO() }).then(() => showToast('Application rejected')).catch(() => showToast('Could not update the application', 'error'));
  }));
  document.querySelectorAll('[data-app-delete]').forEach(b => b.addEventListener('click', () => {
    db.collection('applications').doc(b.getAttribute('data-app-delete')).delete().catch(() => showToast('Could not remove the application', 'error'));
  }));
}
function approveApplication(app, plan){
  const btn = document.getElementById('approve-confirm-btn'); btn.disabled = true; btn.textContent = 'Creating account…';
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const tempPw = Array.from(crypto.getRandomValues(new Uint8Array(12))).map(x => chars[x % chars.length]).join('');
  createOwnerAccount(app.ownerEmail, tempPw).then(ownerUid => {
    const id = slugify(app.businessName) + '-' + Math.floor(Math.random()*900+100), start = new Date();
    const biz = { id, name:app.businessName, category:app.category, emoji:'', ownerUid, location:app.location,
      description: app.description || 'Tell customers about this business — edit it from the business dashboard.',
      rating:0, reviewCount:0, priceFrom:0, coverColor:'linear-gradient(135deg,#1B3550,#0D1B2A)', logoColor:'#FF9F1C',
      whatsapp: app.whatsapp || '', socialLinks:{}, plan,
      subscription: { plan, status:'active', billingCycle: plan==='free' ? null : 'monthly', startDate:localISO(start), expiryDate: plan==='free' ? null : localISO(new Date(start.getFullYear(), start.getMonth()+1, start.getDate())), paymentProvider:null, transactionId:null },
      hours:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d => ({day:d, open:'09:00', close:'18:00'})),
      gallery:[], services:[], reviews:[], staff:[], joined:localISO(start) };
    const ref = db.collection('businesses').doc(id), batch = db.batch();
    batch.set(ref, biz);
    batch.set(ref.collection('private').doc('owner'), { ownerEmail:app.ownerEmail });
    batch.update(db.collection('applications').doc(app.id), { status:'approved', businessId:id, reviewedAt:localISO() });
    adminOwnerEmails[id] = app.ownerEmail;
    return batch.commit().then(() => {
      auth.sendPasswordResetEmail(app.ownerEmail).catch(() => {});
      const num = waNumber(app.whatsapp), first = String(app.ownerName).split(/\s+/)[0];
      sendEmail(app.ownerEmail, first, app.businessName+' is now live on Aura', 'Good news, '+app.businessName+' has been approved and your page is live: '+getShareLink(id)+'  We sent you a separate email to set your password. After that, log in at '+window.location.origin+window.location.pathname+'#login with '+app.ownerEmail+'.');
      const msg = 'Hi ' + first + ', ' + app.businessName + ' is now live on Aura! Log in at ' + window.location.origin + window.location.pathname + '#login with ' + app.ownerEmail + ' and the temporary password ' + tempPw + '. We also emailed you a link to set your own password.';
      openModal(`<div class="modal-head"><h3>Approved</h3><button class="modal-close" onclick="closeModal()">✕</button></div><div class="modal-body"><p>${esc(app.businessName)} is live. A password-reset email is on its way to ${esc(app.ownerEmail)}.</p><div class="summary-row"><span>Temporary password</span><b>${esc(tempPw)}</b></div>${num ? `<a class="btn btn-accent btn-block mt16" target="_blank" rel="noopener" href="https://wa.me/${num}?text=${encodeURIComponent(msg)}">${ICON.chat} Tell ${esc(first)} on WhatsApp</a>` : ''}</div>`);
    });
  }).catch(err => {
    console.error('Approval failed', err);
    showToast(err.code === 'auth/email-already-in-use' ? 'That email already has a login. Ask the applicant for a different one.' : 'Could not approve. Check your connection and try again.', 'error');
    btn.disabled = false; btn.textContent = 'Approve and create account';
  });
}

document.getElementById('mobile-menu-btn').addEventListener('click', ()=>{
  document.getElementById('mobile-nav').classList.toggle('open');
});
document.getElementById('footer-admin-link').addEventListener('click', (e)=>{
  e.preventDefault();
  const user = getCurrentUser();
  if(user && user.role === 'admin'){ navigate('admin'); return; }
  navigate('login');
});

/* ---------------------------------------------------------------------
   21. APP BOOTSTRAP
   --------------------------------------------------------------------- */
(function init(){
  if(!window.location.hash) window.location.hash = 'home';
  startBusinessListener();
  setTimeout(()=>{ const m = document.getElementById('boot-msg'); if(!authReady && m) m.textContent = 'Taking longer than usual - check your internet connection'; }, 12000);
  renderRoute(); // first pass renders public pages immediately; the listener + auth state re-render again once ready
})();