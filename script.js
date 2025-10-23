// ===== Firebase config =====
const firebaseConfig = {
  apiKey: "AIzaSyB3z5GUDdrBdWsBq5PdSgxUatH9UtRkCic",
  authDomain: "abotkamayv2.firebaseapp.com",
  databaseURL: "https://abotkamayv2-default-rtdb.firebaseio.com/",
  projectId: "abotkamayv2",
  storageBucket: "abotkamayv2.firebasestorage.app",
  messagingSenderId: "958314568060",
  appId: "1:958314568060:web:b8e281abb50e95018f2cf9"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const database = firebase.database();
 
// -------------------------
// Seller: Approve Order (owner)
// -------------------------
async function sellerApproveOrder(transactionId, orderData) {
  try {
    // Fetch owner & buyer info
    const [ownerSnap, buyerSnap] = await Promise.all([
      database.ref('users/' + orderData.ownerId).once('value'),
      database.ref('users/' + orderData.buyerId).once('value')
    ]);
    const owner = ownerSnap.val() || {};
    const buyer = buyerSnap.val() || {};

    // 🧾 Build delivery record
    const deliveryData = {
      ...orderData,
      status: "WaitingForDriver", // canonical
      type: "delivery",
      ownerAddress: owner.address || orderData.ownerAddress || '',
      ownerPhone: owner.phone || orderData.ownerPhone || '',
      destination: orderData.destination || buyer.address || '',
      buyerAddress: buyer.address || orderData.buyerAddress || '',
      buyerPhone: buyer.phone || orderData.buyerPhone || "",
      movedToDeliveryAt: Date.now()
    };

    // 🗂️ Atomic updates across all relevant nodes
    const updates = {};

    // Appears for drivers to claim
    updates[`pendingDeliveries/${transactionId}`] = deliveryData;

    // Move to buyer & owner deliveries tab
    updates[`deliveries/${orderData.buyerId}/${transactionId}`] = deliveryData;
    updates[`deliveries/${orderData.ownerId}/${transactionId}`] = deliveryData;

    // Update order status for both buyer & owner
    updates[`orders/${orderData.buyerId}/${transactionId}/status`] = "WaitingForDriver";
    updates[`orders/${orderData.ownerId}/${transactionId}/status`] = "WaitingForDriver";

    // Optional: remove from pendingOrders if exists
    updates[`pendingOrders/${transactionId}`] = null;

    await database.ref().update(updates);

    // ✅ Notify buyer
    pushToast(orderData.buyerId, `✅ Your order ${transactionId} was approved and is now waiting for delivery.`);
    pushTimeline(orderData.buyerId, transactionId, `Order approved by seller and sent for delivery.`);
    pushTimeline(orderData.ownerId, transactionId, `Order moved to delivery list.`);

    Swal.fire("Approved", "Order sent to deliveries for buyer, owner, and drivers.", "success");
  } catch (err) {
    console.error(err);
    Swal.fire("Error", err.message || err, "error");
  }
}
// -------------------------
// 🚚 DRIVER CLAIM DELIVERY (“GET”)
// -------------------------
async function driverClaimDelivery(transactionId, deliveryData) {
  const uid = auth.currentUser?.uid;
  if (!uid) {
    Swal.fire('Not Logged In', 'Please log in as a driver to claim deliveries.', 'warning');
    return;
  }

  try {
    // Fetch driver info
    const driverSnap = await database.ref('users/' + uid).once('value');
    const driver = driverSnap.val() || {};

    // Build updated record
    const claimedData = {
      ...deliveryData,
      driverId: uid,
      driverName: driver.name || 'Driver',
      driverPhone: driver.phone || '',
      status: 'NeedAdminApproval', // waiting for admin to confirm
      claimedAt: Date.now()
    };

    const updates = {};

    // Update the master pendingDeliveries record
    updates[`pendingDeliveries/${transactionId}`] = claimedData;

    // Add to driver’s deliveries tab
    updates[`deliveries/${uid}/${transactionId}`] = claimedData;

    // Optionally update buyer & owner delivery status
    if (deliveryData.buyerId)
      updates[`deliveries/${deliveryData.buyerId}/${transactionId}/status`] = 'NeedAdminApproval';
    if (deliveryData.ownerId)
      updates[`deliveries/${deliveryData.ownerId}/${transactionId}/status`] = 'NeedAdminApproval';

    await database.ref().update(updates);

    // Notifications
    if (deliveryData.buyerId)
      pushToast(deliveryData.buyerId, `🚚 A driver has accepted your order ${transactionId}. Waiting for admin approval.`);
    if (deliveryData.ownerId)
      pushToast(deliveryData.ownerId, `🚚 A driver claimed your delivery ${transactionId}. Waiting for admin approval.`);
    pushToast('admin', `🆕 Driver ${driver.name || uid} claimed order ${transactionId} for delivery.`);

    Swal.fire('Delivery Claimed!', 'You have successfully claimed this delivery. Waiting for admin approval.', 'success');
  } catch (err) {
    console.error('Driver claim error:', err);
    Swal.fire('Error', err.message || 'Something went wrong while claiming the delivery.', 'error');
  }
}

// =========================================================
// 🔴 ADMIN DECLINE DELIVERY (Move to Admin History)
// =========================================================
async function declineDeliveryByAdmin(transactionId, data) {
  try {
    const { value: reason } = await Swal.fire({
      title: 'Decline Delivery Request',
      input: 'text',
      inputPlaceholder: 'Enter reason for decline...',
      showCancelButton: true,
      confirmButtonText: 'Decline',
      confirmButtonColor: '#e74c3c'
    });

    if (!reason) return;

    const declined = {
      ...data,
      status: 'DeclinedByAdmin',
      declineReason: reason,
      declinedAt: Date.now(),
      declinedBy: auth.currentUser?.uid || 'admin'
    };

    const updates = {};

    // ✅ Move to adminHistory
    updates[`adminHistory/${transactionId}`] = declined;

    // ✅ Remove from onProcess
    updates[`onProcess/${transactionId}`] = null;

    // ✅ Remove all deliveries (buyer, owner, driver)
    if (data.buyerId) updates[`deliveries/${data.buyerId}/${transactionId}`] = null;
    if (data.ownerId) updates[`deliveries/${data.ownerId}/${transactionId}`] = null;
    if (data.driverId) updates[`deliveries/${data.driverId}/${transactionId}`] = null;

    await database.ref().update(updates);

    // ✅ Add timeline updates
    const message = `❌ Delivery for ${data.product || 'item'} was declined by admin. Reason: ${reason}`;
    if (typeof pushTimeline === 'function') {
      pushTimeline('admin', transactionId, message);
      if (data.ownerId) pushTimeline(data.ownerId, transactionId, message);
      if (data.driverId) pushTimeline(data.driverId, transactionId, message);
      if (data.buyerId) pushTimeline(data.buyerId, transactionId, message);
    }

    // ✅ Send toast notifications
    if (typeof pushToast === 'function') {
      pushToast(data.ownerId, `⚠️ Delivery declined by admin: ${reason}`);
      pushToast(data.driverId, `⚠️ Delivery declined by admin: ${reason}`);
      pushToast(data.buyerId, `⚠️ Order declined by admin: ${reason}`);
    }

    Swal.fire('Declined', 'Delivery moved to Admin History.', 'info');

    // ✅ Refresh admin panel content safely
    if (typeof loadOnProcess === 'function') try { loadOnProcess(); } catch (e) {}
    if (typeof loadAdminHistory === 'function') try { loadAdminHistory(); } catch (e) {}
    updateCartCounts();

  } catch (err) {
    console.error('Decline delivery error:', err);
    Swal.fire('Error', err.message || 'An error occurred while declining delivery.', 'error');
  }
}

// ======================================================
// 🔢 Transaction ID Generators (Category-based counters)
// ======================================================
async function generateTransactionId(type) {
  let prefix, counterKey;
  switch (type) {
    case 'order': prefix = 'ORD'; counterKey = 'orderCounter'; break;
    case 'delivery': prefix = 'DEL'; counterKey = 'deliveryCounter'; break;
    case 'stock': prefix = 'STK'; counterKey = 'stockCounter'; break;
    default: prefix = 'TRX'; counterKey = 'transactionCounter';
  }
  const ref = database.ref('meta/' + counterKey);
  const snap = await ref.once('value');
  let count = snap.val() || 0;
  count++;
  await ref.set(count);
  return prefix + String(count).padStart(3, '0');
}

// ======================================================
// 🧹 Retro-assign Transaction IDs for old records
// ======================================================
async function retroAssignTransactionIds() {
  const paths = [
    { path: 'orders', type: 'order' },
    { path: 'deliveries', type: 'delivery' },
    { path: 'stocks', type: 'stock' },
    { path: 'onProcess', type: 'delivery' },
    { path: 'adminHistory', type: 'transaction' },
    { path: 'transactions', type: 'transaction' }
  ];
  for (const p of paths) {
    const snap = await database.ref(p.path).once('value');
    if (!snap.exists()) continue;
    const updates = {};
    snap.forEach(u => {
      if (p.path === 'orders' || p.path === 'deliveries') {
        u.forEach(item => {
          if (!item.val().transactionId) {
            const id = generateTransactionId(p.type);
            id.then(newId => {
              database.ref(`${p.path}/${u.key}/${item.key}/transactionId`).set(newId);
            });
          }
        });
      } else {
        if (!u.val().transactionId) {
          const id = generateTransactionId(p.type);
          id.then(newId => {
            database.ref(`${p.path}/${u.key}/transactionId`).set(newId);
          });
        }
      }
    });
  }
}
// =========================================================
// 🟢 ADMIN APPROVE DELIVERY (Require delivery payment input)
// =========================================================
async function adminApprovePendingDelivery(transactionId, data) {
  try {
    const htmlContent = `
      <div style="text-align:left;line-height:1.6">
        <h3>🚚 Rider Information</h3>
        <p><strong>Name:</strong> ${data.driverName || 'N/A'}</p>
        <p><strong>Phone:</strong> ${data.driverPhone || 'N/A'}</p>
        <hr>
        <h3>🛍️ Buyer Information</h3>
        <p><strong>Name:</strong> ${data.buyerName || 'N/A'}</p>
        <p><strong>Address:</strong> ${data.buyerAddress || 'N/A'}</p>
        <p><strong>Phone:</strong> ${data.buyerPhone || 'N/A'}</p>
        <hr>
        <h3>🏪 Seller Information</h3>
        <p><strong>Name:</strong> ${data.ownerName || 'N/A'}</p>
        <p><strong>Address:</strong> ${data.ownerAddress || 'N/A'}</p>
        <p><strong>Phone:</strong> ${data.ownerPhone || 'N/A'}</p>
        <hr>
        <label><strong>Enter Delivery Payment (₱):</strong></label>
        <input type="number" id="deliveryPaymentInput" class="swal2-input" min="1" placeholder="e.g. 100">
      </div>
    `;

    // 🔸 Show modal
    const { value: deliveryPayment } = await Swal.fire({
      title: 'Approve Delivery',
      html: htmlContent,
      showCancelButton: true,
      confirmButtonText: 'Confirm Approval',
      didOpen: () => {
        const input = Swal.getPopup().querySelector('#deliveryPaymentInput');
        const confirmButton = Swal.getConfirmButton();
        confirmButton.disabled = true; // Disable initially

        input.addEventListener('input', () => {
          const val = Number(input.value);
          confirmButton.disabled = isNaN(val) || val <= 0;
        });
      },
      preConfirm: () => {
        const input = document.getElementById('deliveryPaymentInput').value;
        if (!input || isNaN(input) || Number(input) <= 0) {
          Swal.showValidationMessage('Please enter a valid delivery payment.');
          return false;
        }
        return Number(input);
      }
    });

    if (deliveryPayment === undefined) return; // Cancelled

    const time = Date.now();
    const price = Number(data.price) || 0;
    const qty = Number(data.qty) || 0;
    const deliveryFee = Number(data.deliveryFee) || 0;

    // ✅ Total payment = price * qty + delivery fee + delivery payment
    const totalPayment = (price * qty) + deliveryFee + Number(deliveryPayment);

    // ✅ Update record
    const approved = {
      ...data,
      status: 'ItemOutForDelivery',
      deliveryPayment: Number(deliveryPayment),
      totalPayment,
      approvedAt: time,
      approvedBy: auth.currentUser?.uid || 'admin'
    };

    const updates = {};
    updates[`onProcess/${transactionId}`] = approved;

    // Sync to all roles' delivery lists
    if (data.buyerId)
      updates[`deliveries/${data.buyerId}/${transactionId}`] = { ...approved, viewType: 'buyer', movedToDeliveryAt: time };
    if (data.ownerId)
      updates[`deliveries/${data.ownerId}/${transactionId}`] = { ...approved, viewType: 'owner', movedToDeliveryAt: time };
    if (data.driverId)
      updates[`deliveries/${data.driverId}/${transactionId}`] = { ...approved, viewType: 'driver', movedToDeliveryAt: time };

    await database.ref().update(updates);

    // ✅ Push timeline update (all parties can see)
    const timelineMsg = `🚚 Admin approved delivery for "${data.product || 'item'}" with ₱${deliveryPayment} delivery payment. Total: ₱${totalPayment.toLocaleString()}`;
    if (typeof pushTimeline === 'function') {
      pushTimeline('admin', transactionId, timelineMsg);
      if (data.buyerId) pushTimeline(data.buyerId, transactionId, timelineMsg);
      if (data.ownerId) pushTimeline(data.ownerId, transactionId, timelineMsg);
      if (data.driverId) pushTimeline(data.driverId, transactionId, timelineMsg);
    }

    // ✅ Toast Notifications
    if (typeof pushToast === 'function') {
      pushToast(data.driverId, `📦 New delivery approved — ₱${deliveryPayment} delivery payment.`);
      pushToast(data.ownerId, `📤 Your item ${data.product || ''} is out for delivery (₱${totalPayment.toLocaleString()} total).`);
      pushToast(data.buyerId, `📦 Your order ${data.product || ''} is on the way! Total: ₱${totalPayment.toLocaleString()}`);
    }

    Swal.fire('Approved!', `Delivery approved with ₱${deliveryPayment} payment (Total: ₱${totalPayment.toLocaleString()}).`, 'success');

    if (typeof loadOnProcess === 'function') loadOnProcess();
    if (typeof loadDeliveries === 'function') loadDeliveries();

  } catch (err) {
    console.error('Approval error:', err);
    Swal.fire('Error', err.message || 'An error occurred while approving delivery.', 'error');
  }
}



// 🧹 Auto-cleanup older admin logs every 24 hours
function cleanOldAdminLogs() {
  const ref = database.ref('adminActivity');
  ref.once('value', snap => {
    if (!snap.exists()) return;
    const logs = [];
    snap.forEach(c => logs.push({ id: c.key, ...c.val() }));
    logs.sort((a, b) => b.timestamp - a.timestamp);

    if (logs.length > 50) {
      const toRemove = logs.slice(50);
      toRemove.forEach(l => database.ref('adminActivity/' + l.id).remove().catch(() => {}));
    }
  });
}

// Run once per day automatically
setInterval(cleanOldAdminLogs, 24 * 60 * 60 * 1000);

// ===== globals & element references =====
let currentUserRole = "customer"; // can be: customer, farmer, wholesaler, driver, driverIN, driverOUT, admin

let listeners = {}; // store active listener refs to off() them

// UI elements
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const showSignup = document.getElementById('showSignup');
const showLogin = document.getElementById('showLogin');
const mainApp = document.getElementById('mainApp');
const authSection = document.getElementById('authSection');
const bottomNav = document.getElementById('bottomNav');
const darkToggle = document.getElementById('darkToggle');

const deliverReceiverName = document.getElementById('deliverReceiverName');
const deliverReceiverPhone = document.getElementById('deliverReceiverPhone');

// Profile display
const profileNameDisplay = document.getElementById('profileNameDisplay');
const profileEmailDisplay = document.getElementById('profileEmailDisplay');
const profilePhoneDisplay = document.getElementById('profilePhoneDisplay');
const profileAddressDisplay = document.getElementById('profileAddressDisplay');

// CART UI
const ordersList = document.getElementById('ordersList');
const deliveriesList = document.getElementById('deliveriesList');
const historyList = document.getElementById('historyList');

// Admin CART UI (cards inside cartContent)
const pendingList = document.getElementById('pendingAdminList');
const onProcessList = document.getElementById('onProcessAdminList');
const adminHistoryList = document.getElementById('adminHistoryList');

// Account management UI (admin area)
const adminPendingList = document.getElementById('pendingList');
const adminApprovedList = document.getElementById('approvedList');
const adminBlackList = document.getElementById('blackList');

// Home elements
const tabBuyBtn = document.getElementById('tabBuyBtn');
const tabSellBtn = document.getElementById('tabSellBtn');
const tabDeliverBtn = document.getElementById('tabDeliverBtn');
const homeBuy = document.getElementById('homeBuy');
const homeSell = document.getElementById('homeSell');
const homeDeliver = document.getElementById('homeDeliver');
const homeBuyList = document.getElementById('homeBuyList');
const homeSellList = document.getElementById('homeSellList');
const homeDeliverList = document.getElementById('homeDeliverList');
const homeBuyEmpty = document.getElementById('homeBuyEmpty');
const homeSellEmpty = document.getElementById('homeSellEmpty');
const homeDeliverEmpty = document.getElementById('homeDeliverEmpty');

// Sell inputs
const sellProduct = document.getElementById('sellProduct');
const sellQty = document.getElementById('sellQty');
const sellPrice = document.getElementById('sellPrice');
const sellBtn = document.getElementById('sellBtn');

// Deliver inputs
const deliverProduct = document.getElementById('deliverProduct');
const deliverQty = document.getElementById('deliverQty');
const deliverDestination = document.getElementById('deliverDestination');
const deliverBtn = document.getElementById('deliverBtn');

// Checkout modal elements
const checkoutModal = document.getElementById('checkoutModal');
const checkoutProductInfo = document.getElementById('checkoutProductInfo');
const checkoutQty = document.getElementById('checkoutQty');
const checkoutDestinationWrap = document.getElementById('checkoutDestinationWrap');
const checkoutDestination = document.getElementById('checkoutDestination');
const confirmCheckoutBtn = document.getElementById('confirmCheckoutBtn');
const cancelCheckoutBtn = document.getElementById('cancelCheckoutBtn');
const checkoutMethod = document.getElementById('checkoutMethod'); // if present in DOM

// Buttons
const loginBtn = document.getElementById('loginBtn');
const signupBtn = document.getElementById('signupBtn');
const logoutBtn = document.getElementById('logoutBtn');

// Cart visual / counts
const ordersCountEl = document.getElementById('ordersCount');
const deliveriesCountEl = document.getElementById('deliveriesCount');
const historyCountEl = document.getElementById('historyCount');
const adminPendingCountEl = document.getElementById('adminPendingCount');
const adminOnProcessCountEl = document.getElementById('adminOnProcessCount');
const adminHistoryCountEl = document.getElementById('adminHistoryCount');

// Search boxes (may be optional)
const searchHistoryInput = document.getElementById('searchHistory');
const searchOnProcessInput = document.getElementById('searchOnProcess');

// Activity feed
const activityList = document.getElementById('activityList');
let activityItems = [];

// helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const statusIcons = {
  pending: '<i class="fas fa-hourglass-half"></i>',
  onprocess: '<i class="fas fa-cogs"></i>',
  success: '<i class="fas fa-check-circle"></i>',
  failed: '<i class="fas fa-times-circle"></i>',
  declined: '<i class="fas fa-ban"></i>',
  canceled: '<i class="fas fa-ban"></i>'
};
// Add countdown timers map
let countdownIntervals = {};

// Utility: start countdown for item (5 minutes default)
function startCountdown(uid, id, payload, type="order"){
  const endTime = Date.now() + 5*60*1000; // 5 min
  database.ref('countdowns/'+id).set({ endTime });
  countdownIntervals[id] = setInterval(()=>{
    const remaining = endTime - Date.now();
    if(remaining <= 0){
      clearInterval(countdownIntervals[id]);
      delete countdownIntervals[id];
      if(payload && uid){
        // auto cancel if not approved yet
        database.ref('pendingRequests/'+id).remove();
        database.ref(type==='order'?'orders':'deliveries'+'/'+uid+'/'+id).update({status:'canceled', autoCanceled:true});
        database.ref('history/'+uid+'/'+id).set({...payload, status:'canceled', autoCanceled:true, finishedAt:Date.now()});
        database.ref('adminHistory/'+id).set({...payload, status:'canceled', autoCanceled:true, finishedAt:Date.now()});
      }
    }
  }, 1000);
}
function registerUser(uid, data){
  database.ref('users/'+uid).set({
    ...data,
    creditScore: 100
  });
}

// Utility: format time remaining
function formatRemaining(ms){
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const sec = s%60;
  return `${m}:${sec<10?'0'+sec:sec}`;
}
// ===== UI toggles =====
if (showSignup) showSignup.addEventListener('click', ()=> { loginForm?.classList.add('hidden'); signupForm?.classList.remove('hidden'); });
if (showLogin) showLogin.addEventListener('click', ()=> { signupForm?.classList.add('hidden'); loginForm?.classList.remove('hidden'); });

if(localStorage.getItem('ab_dark') === '1') document.body.classList.add('dark');
if (darkToggle) darkToggle.addEventListener('click', ()=> {
  document.body.classList.toggle('dark');
  localStorage.setItem('ab_dark', document.body.classList.contains('dark') ? '1' : '0');
});
// Auto-fill Apply Name
auth.onAuthStateChanged(user => {
  if (user) {
    const nameInput = document.getElementById('applyName');

    // 🟢 Auto-fill the "Full Name" field
    database.ref('users/' + user.uid + '/name').once('value').then(snap => {
      if (nameInput) nameInput.value = snap.val() || user.displayName || '';
    });

    // 📬 Load inbox for every logged-in user
    loadInbox();

    // 🧩 Check if the user is an admin and load badge dots
    database.ref('users/' + user.uid + '/role').once('value').then(roleSnap => {
      const role = roleSnap.val();
      if (role === 'admin') {
        updateAdminDots(); // 🔴 Start listening to Firebase for badge counts
      }
    });
  }
});
// ✅ Safe Real-time Admin Badge Updater
function updateAdminDots() {
  // Make sure admin tab exists before updating
  const appsDot = document.getElementById('dot-applications');
  if (!appsDot) {
    console.warn('Admin dots not loaded yet, retrying...');
    setTimeout(updateAdminDots, 800);
    return;
  }

  // Clean up old listeners if they exist
  const refs = [
    'users', 'reports', 'applications', 'stocks', 'deliveries', 'transactions'
  ];
  refs.forEach(path => database.ref(path).off('value'));

  // --- Pending Accounts ---
  database.ref('users').on('value', snap => {
    let pendingCount = 0;
    snap.forEach(child => {
      if (child.val().status === 'pending') pendingCount++;
    });
    updateDot('dot-pending', pendingCount);
  });

  // --- Reports ---
  database.ref('reports').on('value', snap => {
    const count = snap.exists() ? snap.numChildren() : 0;
    updateDot('dot-reports', count);
  });

  // --- Applications ---
  database.ref('applications').on('value', snap => {
    let appCount = 0;
    snap.forEach(child => {
      if (child.val().status === 'pending') appCount++;
    });
    updateDot('dot-applications', appCount);
  });

  // --- Stocks ---
  database.ref('stocks').on('value', snap => {
    let stockCount = 0;
    snap.forEach(child => {
      if (child.val().status === 'pending') stockCount++;
    });
    updateDot('dot-stock', stockCount);
  });

  // --- Deliveries ---
  database.ref('deliveries').on('value', snap => {
    let deliveryCount = 0;
    snap.forEach(child => {
      const s = child.val().status;
      if (s === 'for pickup' || s === 'on delivery') deliveryCount++;
    });
    updateDot('dot-delivery', deliveryCount);
  });

  // --- Transactions ---
  database.ref('transactions').on('value', snap => {
    let processCount = 0, transCount = 0;
    snap.forEach(child => {
      const s = child.val().status;
      if (s === 'processing' || s === 'review') processCount++;
      if (s === 'completed') transCount++;
    });
    updateDot('dot-process', processCount);
    updateDot('dot-transactions', transCount);
  });
}


// ✅ Tab highlight logic (no hiding)
function setupApplyTabs() {
  const applyTabBtn = document.getElementById('applyTabBtn');
  const inboxTabBtn = document.getElementById('inboxTabBtn');

  if (applyTabBtn && inboxTabBtn) {
    applyTabBtn.onclick = () => {
      applyTabBtn.classList.add('active');
      inboxTabBtn.classList.remove('active');
    };

    inboxTabBtn.onclick = () => {
      inboxTabBtn.classList.add('active');
      applyTabBtn.classList.remove('active');
      loadInbox();
    };
  }
}


// ===== AUTH =====
if (signupBtn) signupBtn.addEventListener('click', ()=> {
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const pass = document.getElementById('signupPassword').value;
  const phone = document.getElementById('signupPhone').value.trim();
  const address = document.getElementById('signupAddress').value.trim();
  const reason = document.getElementById('signupReason').value.trim();
  const role = document.getElementById('signupRole').value;
  if(!name||!email||!pass||!phone||!address||!reason){ Swal.fire('Error','All fields required','error'); return; }
  if(pass.length < 6){ Swal.fire('Weak Password','Password must be at least 6 characters','warning'); return; }

  auth.createUserWithEmailAndPassword(email, pass)
    .then(cred=>{
      return database.ref('users/'+cred.user.uid).set({ 
        name,
        email,
        phone,
        address,
        reason,
        role,
        status: 'pending',
        createdAt: Date.now(),
        creditScore: 100   // 🔹 default score
      });
    })
    .then(()=>{
      Swal.fire('Registered','Wait for admin approval','success');
      signupForm?.classList.add('hidden'); 
      loginForm?.classList.remove('hidden');
    })
    .catch(err=> Swal.fire('Error', err.message, 'error'));
});  // 👈 closed signup block

// ✅ separate block for login
if (loginBtn) loginBtn.addEventListener('click', ()=> {
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPassword').value;
  auth.signInWithEmailAndPassword(email, pass)
    .then(cred=>{
      database.ref('users/'+cred.user.uid).once('value').then(snap=>{
        const user = snap.val();
        if(!user){ Swal.fire('Error','No account record','error'); auth.signOut(); return; }
        if(user.status !== 'approved'){ auth.signOut(); Swal.fire('Not Approved','Your account is still pending approval','warning'); return; }
        currentUserRole = user.role || 'customer';
        showAppForUser(user);
      });
    })
    .catch(err=> Swal.fire('Error', err.message, 'error'));
});

auth.onAuthStateChanged(user=>{
  if(user){
    database.ref('users/'+user.uid).once('value').then(snap=>{
      const u = snap.val();
      if(u){
        if(u.status === 'approved'){
          currentUserRole = u.role || 'customer';
          showAppForUser(u);
        } 
        else if(u.status === 'blacklisted'){
          Swal.fire(
            'Blocked',
            'Your account has been blacklisted. Please contact support.',
            'error'
          ).then(()=>{
            auth.signOut();
            showSignedOut();
          });
        } 
        else {
          // pending, declined, or anything else
          auth.signOut();
          showSignedOut();
        }
      } else {
        auth.signOut();
        showSignedOut();
      }
    }).catch(()=> showSignedOut());
  } else {
    showSignedOut();
  }
});

if (logoutBtn) logoutBtn.addEventListener('click', ()=> {
  Swal.fire({
    title:'Logout?',
    icon:'warning',
    showCancelButton:true,
    confirmButtonText:'Logout'
  }).then(res=>{
    if(res.isConfirmed){
      Object.keys(listeners).forEach(k => { try{ listeners[k].off(); } catch(e){} });
      listeners = {};
      auth.signOut();
      showSignedOut();
    }
  });
});

function showSignedOut(){
  authSection?.classList.remove('hidden');
  mainApp?.classList.add('hidden');
  bottomNav?.classList.add('hidden');
  loginForm?.classList.remove('hidden');
  signupForm?.classList.add('hidden');
}

function showAppForUser(u) {
  authSection?.classList.add('hidden');
  mainApp?.classList.remove('hidden');
  bottomNav?.classList.remove('hidden');
  setTimeout(() => {
    mainApp.classList.add('show');
    bottomNav.classList.add('show');
  }, 20);

  const role = (u.role || 'customer').toLowerCase();
  currentUserRole = role;

  // --- Cache elements ---
  const cartNav = document.getElementById('cartNav');
  const applyNav = document.getElementById('applyNav');
  const adminNav = document.getElementById('adminNav');
  const tabBuyBtn = document.getElementById('tabBuyBtn');
  const tabSellBtn = document.getElementById('tabSellBtn');
  const tabDeliverBtn = document.getElementById('tabDeliverBtn');

  // --- Hide all by default (avoid flicker)
  if (cartNav) cartNav.classList.add('hidden');
  if (applyNav) applyNav.classList.add('hidden');
  if (adminNav) adminNav.classList.add('hidden');
  if (tabBuyBtn) tabBuyBtn.style.display = 'none';
  if (tabSellBtn) tabSellBtn.style.display = 'none';
  if (tabDeliverBtn) tabDeliverBtn.style.display = 'none';

  // --- Role-based immediate visibility ---
  switch (role) {
    case 'admin':
      if (adminNav) adminNav.classList.remove('hidden'); // ✅ Show admin panel
      if (tabBuyBtn) tabBuyBtn.style.display = '';       // ✅ Admin can Buy
      if (tabSellBtn) tabSellBtn.style.display = 'none'; // 🚫 Hide Sell
      if (tabDeliverBtn) tabDeliverBtn.style.display = 'none'; // 🚫 Hide Deliver
      if (cartNav) cartNav.classList.add('hidden');      // 🚫 Hide Cart
      if (applyNav) applyNav.classList.add('hidden');    // 🚫 Hide Apply
      // Run once immediately when admin panel loads
checkExpiredStocks();

      break;

    case 'farmer':
      if (tabSellBtn) tabSellBtn.style.display = '';     // ✅ Farmer can Sell
      if (cartNav) cartNav.classList.remove('hidden');   // ✅ Farmer has Cart
      break;

    case 'customer':
      if (tabBuyBtn) tabBuyBtn.style.display = '';       // ✅ Customer can Buy
      if (applyNav) applyNav.classList.remove('hidden'); // ✅ Show Apply
      if (cartNav) cartNav.classList.remove('hidden');   // ✅ Has Cart
      break;

    case 'wholesaler':
      if (tabBuyBtn) tabBuyBtn.style.display = '';       // ✅ Can Buy
      if (tabSellBtn) tabSellBtn.style.display = '';     // ✅ Can Sell
      if (cartNav) cartNav.classList.remove('hidden');   // ✅ Has Cart
      break;

    case 'driver':
    case 'driverin':
    case 'driverout':
      if (tabDeliverBtn) tabDeliverBtn.style.display = ''; // ✅ Deliver tab
      if (cartNav) cartNav.classList.remove('hidden');     // ✅ Has Cart
      break;

    default:
      if (tabBuyBtn) tabBuyBtn.style.display = '';
      if (tabSellBtn) tabSellBtn.style.display = '';
      if (tabDeliverBtn) tabDeliverBtn.style.display = '';
      if (cartNav) cartNav.classList.remove('hidden');
      
  }



  // --- Continue normal setup ---
  setupRoleUI(u.role || 'customer');
  loadBuyTabItems();

  const uid = auth.currentUser?.uid;
  if (uid) {
    loadCart(uid);
    loadProfile(uid);
    loadStocksAndSellList(uid);
  }

  if (role === 'admin') {
    loadAccounts();
    loadAdminTabs();
    retroAssignTransactionIds();
  }

  loadProfile(uid);
  setupApplyForm(u);

  if (deliverDestination && u.address) {
    deliverDestination.value = u.address;
    deliverDestination.readOnly = true;
  }

  initActivityFeedAuto();
  setupDeliveryRealtimeListeners();
}

function setupRoleUI(role) {
  // 🔹 Normalize sub-driver roles
  role = role ? role.toLowerCase() : 'customer';
  if (role === 'driverin' || role === 'driverout') role = 'driver';

  currentUserRole = role;

  // --- Cached navs ---
  const adminNav = document.getElementById('adminNav');
  const cartNav = document.getElementById('cartNav');
  const applyNav = document.getElementById('applyNav');

  // Hide all first
  if (adminNav) adminNav.classList.add('hidden');
  if (cartNav) cartNav.classList.add('hidden');
  if (applyNav) applyNav.classList.add('hidden');

  // --- Hide or show per role ---
  $$('.admin-only').forEach(el => el.style.display = role === 'admin' ? '' : 'none');
  $$('.driver-only').forEach(el => {
    el.style.display = (role === 'driver' || role === 'admin') ? '' : 'none';
  });

  // Reset all tabs
  [tabBuyBtn, tabSellBtn, tabDeliverBtn].forEach(btn => btn?.classList.remove('active'));

  // --- Role-specific tab visibility ---
  if (role === 'farmer') {
    tabBuyBtn.style.display = 'none';
    tabSellBtn.style.display = '';
    tabDeliverBtn.style.display = 'none';
    if (cartNav) cartNav.classList.remove('hidden'); // ✅ Farmer has Cart
  }

  else if (role === 'customer') {
    tabBuyBtn.style.display = '';
    tabSellBtn.style.display = 'none';
    tabDeliverBtn.style.display = 'none';
    if (applyNav) applyNav.classList.remove('hidden'); // ✅ Apply visible
    if (cartNav) cartNav.classList.remove('hidden');   // ✅ Cart visible
    loadBuyTabItems();
  }

  else if (role === 'wholesaler') {
    tabBuyBtn.style.display = '';
    tabSellBtn.style.display = '';
    tabDeliverBtn.style.display = 'none';
    if (cartNav) cartNav.classList.remove('hidden');   // ✅ Cart visible
    loadBuyTabItems();
  }

  else if (role === 'driver') {
    tabBuyBtn.style.display = 'none';
    tabSellBtn.style.display = 'none';
    tabDeliverBtn.style.display = '';
    if (cartNav) cartNav.classList.remove('hidden');   // ✅ Cart visible
    initDriverDeliverScreen();
  }

else if (role === 'admin') {
  // ✅ Admin sees only BUY tab
  if (adminNav) adminNav.classList.remove('hidden');
  tabBuyBtn.style.display = '';        // ✅ Show Buy
  tabSellBtn.style.display = 'none';   // 🚫 Hide Sell
  tabDeliverBtn.style.display = 'none';// 🚫 Hide Deliver

  if (cartNav) cartNav.classList.add('hidden');   // Hide Cart
  if (applyNav) applyNav.classList.add('hidden'); // Hide Apply

  // 🟢 Always show HOME page with Buy tab active
  showPage('homeContent');
  $$('#homeContent .home-section').forEach(s => s.classList.add('hidden'));
  document.getElementById('homeBuy')?.classList.remove('hidden');

  // Activate Buy tab button
  tabBuyBtn?.classList.add('active');
  tabSellBtn?.classList.remove('active');
  tabDeliverBtn?.classList.remove('active');

  // Load Buy items
  loadBuyTabItems();
}




  else {
    // Default fallback
    tabBuyBtn.style.display = '';
    tabSellBtn.style.display = '';
    tabDeliverBtn.style.display = '';
  }

  // ===== Page Landing per role =====
  if (role === 'farmer') {
    showPage('homeContent');
    $$('#homeContent .home-section').forEach(s => s.classList.add('hidden'));
    document.getElementById('homeSell')?.classList.remove('hidden');
    tabSellBtn?.classList.add('active');
  }
  else if (role === 'customer' || role === 'wholesaler') {
    showPage('homeContent');
    $$('#homeContent .home-section').forEach(s => s.classList.add('hidden'));
    document.getElementById('homeBuy')?.classList.remove('hidden');
    tabBuyBtn?.classList.add('active');
  }
  else if (role === 'driver') {
    showPage('homeContent');
    $$('#homeContent .home-section').forEach(s => s.classList.add('hidden'));
    document.getElementById('homeDeliver')?.classList.remove('hidden');
    tabDeliverBtn?.classList.add('active');
  }
  else if (role === 'admin') {
    showPage('adminContent');
    loadAccounts();
    loadAdminTabs();
    loadReports();
    attachAdminTabHandlers();
  }

  // 🔹 Attach handlers
  attachNavHandlers();
  attachHomeTabHandlers();
  attachCartTabHandlers();
  attachCartVisualHandlers();
}


// =========================================================
// 🚚 DRIVER DELIVERY MANAGEMENT
// =========================================================
function initDriverDeliverScreen() {
  const deliverSection = document.getElementById('homeDeliver');
  if (!deliverSection) return;

  deliverSection.innerHTML = `
    <h2>Driver Delivery Management</h2>
    <div id="driverCheckPanel" class="auth-panel">
      <button id="driverCheckInBtn" class="cta-button small">Check In</button>
      <button id="driverCheckOutBtn" class="cta-button small outline">Check Out</button>
    </div>
    <div class="auth-panel">
      <h3>Available Deliveries</h3>
      <div id="driverDeliveryList" class="list-wrapper"></div>
    </div>
  `;

  const uid = auth.currentUser?.uid;
  const userRef = database.ref('users/' + uid);
  const checkInBtn = document.getElementById('driverCheckInBtn');
  const checkOutBtn = document.getElementById('driverCheckOutBtn');
  const listDiv = document.getElementById('driverDeliveryList');

  if (!uid || !checkInBtn || !checkOutBtn) return;

  // Load current role to set initial button states
  userRef.once('value').then(snap => {
    const u = snap.val() || {};
    updateDriverButtonState(u.role || 'driver');
  });

  // --- Button Handlers ---
  checkInBtn.onclick = () => {
    updateDriverRole('DriverIN', userRef, listDiv);
  };

  checkOutBtn.onclick = () => {
    updateDriverRole('DriverOUT', userRef, listDiv);
  };

  // Initial load of deliveries
  loadDriverDeliveryList(listDiv);

  // Schedule daily reset
  resetDriverRolesDaily();
}

// =========================================================
// 🔧 Update driver role + refresh UI
// =========================================================
function updateDriverRole(newRole, userRef, listDiv) {
  userRef.update({ role: newRole, updatedAt: Date.now() }).then(() => {
    Swal.fire('Status Updated', `You are now ${newRole}`, 'success');
    setupRoleUI(newRole);
    updateDriverButtonState(newRole);
    loadDriverDeliveryList(listDiv);
  });
}

// =========================================================
// 🔁 Enable / disable Check In / Out buttons depending on role
// =========================================================
function updateDriverButtonState(role) {
  const checkInBtn = document.getElementById('driverCheckInBtn');
  const checkOutBtn = document.getElementById('driverCheckOutBtn');
  if (!checkInBtn || !checkOutBtn) return;

  const r = role.toLowerCase();
  if (r === 'driverin') {
    checkInBtn.disabled = true;
    checkOutBtn.disabled = false;
  } else if (r === 'driverout') {
    checkInBtn.disabled = false;
    checkOutBtn.disabled = true;
  } else {
    checkInBtn.disabled = false;
    checkOutBtn.disabled = false;
  }
}

// =========================================================
// 🔄 Reset all DriverIN/DriverOUT back to Driver once daily
// =========================================================
function resetDriverRolesDaily() {
  const today = new Date().toDateString();
  const lastReset = localStorage.getItem('lastDriverReset');
  if (lastReset === today) return;

  database.ref('users').once('value', snap => {
    snap.forEach(child => {
      const u = child.val();
      if (!u?.role) return;
      const r = u.role.toLowerCase();
      if (r === 'driverin' || r === 'driverout') {
        database.ref('users/' + child.key + '/role').set('Driver');
      }
    });
  });

  localStorage.setItem('lastDriverReset', today);
}

// =========================================================
// 🚚 LOAD DRIVER DELIVERY LIST (DriverIN & DRIVEROUT)
// =========================================================
function loadDriverDeliveryList(container) {
  const uid = auth.currentUser?.uid;
  if (!uid || !container) return;

  database.ref("users/" + uid).once("value").then(async (userSnap) => {
    const user = userSnap.val() || {};
    const role = (user.role || "").toLowerCase();
    const ref = database.ref("pendingDeliveries");

    // 🟢 DRIVERIN: Available deliveries to claim
    if (role === "driverin") {
      ref.on("value", async (snap) => {
        container.innerHTML = "";
        if (!snap.exists()) {
          container.innerHTML = `<div class="empty-state">No available deliveries right now.</div>`;
          return;
        }

        for (const [id, d] of Object.entries(snap.val())) {
          if (d.status !== "WaitingForDriver") continue;

          const price = Number(d.price) || 0;
          const qty = Number(d.qty) || 0;
          const total = price * qty;

          const card = document.createElement("div");
          card.className = "delivery-card";
          card.innerHTML = `
            <div class="product-info">
              <div class="product-row">
                <strong>${d.product || "Unknown Item"}</strong>
                <span class="badge">${qty} KG</span>
              </div>
              <div class="product-row">
                <span class="badge price">₱${total.toLocaleString()}</span>
                <span class="badge stock">Owner: ${d.ownerName || "N/A"}</span>
              </div>
              <p><small>₱${price.toLocaleString()} per KG × ${qty}KG</small></p>
              <p><small><strong>FROM:</strong> ${d.ownerAddress || "N/A"}</small></p>
              <p><small><strong>TO:</strong> ${d.destination || "N/A"}</small></p>
              <p><small>Status: ${d.status || "Pending"}</small></p>
            </div>
            <div class="card-actions">
              <button class="cta-button small" id="get-${id}">GET</button>
            </div>
          `;

          // 🟢 GET Button logic
          const getBtn = card.querySelector(`#get-${id}`);
          getBtn.onclick = async () => {
            const res = await Swal.fire({
              title: "Accept this delivery?",
              icon: "question",
              showCancelButton: true,
              confirmButtonText: "Yes, Get It",
            });

            if (!res.isConfirmed) return;

            const updated = {
              ...d,
              driverId: uid,
              driverName: user.name || "Driver",
              driverPhone: user.phone || "",
              status: "NeedAdminApproval",
              acceptedAt: Date.now(),
            };

            // Update the item status in pendingDeliveries
            await database.ref("pendingDeliveries/" + id).set(updated);

            if (d.buyerId)
              pushToast(d.buyerId, `🚚 Your order for ${d.product} has been picked by a driver.`);
            if (d.ownerId)
              pushToast(d.ownerId, `🚚 A driver has accepted to deliver ${d.product}.`);

            Swal.fire("Accepted", "Delivery is now waiting for admin approval.", "success");
          };

          container.appendChild(card);
        }
      });
    }

    // 🔵 DRIVEROUT: Deliveries claimed by this driver (NeedAdminApproval)
    else if (role === "driverout") {
      ref.on("value", async (snap) => {
        container.innerHTML = "";
        if (!snap.exists()) {
          container.innerHTML = `<div class="empty-state">No deliveries claimed yet.</div>`;
          return;
        }

        for (const [id, d] of Object.entries(snap.val())) {
          // Only show deliveries claimed by this driver
          if (d.driverId !== uid || d.status !== "NeedAdminApproval") continue;

          const price = Number(d.price) || 0;
          const qty = Number(d.qty) || 0;
          const total = price * qty;

          const card = document.createElement("div");
          card.className = "delivery-card";
          card.innerHTML = `
            <div class="product-info">
              <div class="product-row">
                <strong>${d.product || "Delivery Item"}</strong>
                <span class="badge">${qty} KG</span>
              </div>
              <div class="product-row">
                <span class="badge price">₱${total.toLocaleString()}</span>
                <span class="badge stock">Owner: ${d.ownerName || "N/A"}</span>
              </div>
              <p><small>₱${price.toLocaleString()} per KG × ${qty}KG</small></p>
              <p><small><strong>FROM:</strong> ${d.ownerAddress || "N/A"}</small></p>
              <p><small><strong>TO:</strong> ${d.destination || "N/A"}</small></p>
              <p><em>📞 Phone numbers hidden until admin approval.</em></p>
              <p><small>Status: ${d.status || "NeedAdminApproval"}</small></p>
            </div>
          `;

          // ❌ No GET or action buttons — driver just waits for admin
          container.appendChild(card);
        }
      });
    }

    // 🚫 No delivery role
    else {
      container.innerHTML = `<div class="empty-state">You have no delivery access.</div>`;
    }
  });
}

// =========================================================
// 🚚 DRIVER: ACCEPT DELIVERY (moves to onProcess)
// =========================================================
function driverAcceptDelivery(id, deliveryData) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  database.ref('users/' + uid).once('value').then(snap => {
    const user = snap.val() || {};

    const updated = {
      ...deliveryData,
      driverId: uid,
      driverName: user.name || 'Driver',
      driverPhone: user.phone || '',
      status: 'WaitForAdminApproval',
      acceptedAt: Date.now()
    };

    // ✅ Move delivery to /onProcess/
    database.ref('onProcess/' + id).set(updated).then(() => {
      // 🧹 Remove from pendingDeliveries
      database.ref('pendingDeliveries/' + id).remove();
      Swal.fire('Accepted', 'Waiting for Admin approval.', 'success');
    });
  });
}

// ===== Navigation Helpers =====
function attachNavHandlers() {
  const navs = document.querySelectorAll('.bottom-nav .nav-btn');
  navs.forEach(btn => {
    btn.onclick = () => {
      const page = btn.dataset.page;
      showPage(page);

      // 🧩 Cart page handling
      if (page === 'cartContent') {
        if (currentUserRole === 'admin') loadAdminTabs();
        else loadCart(auth.currentUser?.uid);
      }

      // 🧩 Admin accounts page
      if (page === 'adminContent') loadAccounts();

      // 🧩 Tabs inside the cart (like deliveries, history, etc.)
      if (page === 'onProcessTab' || page === 'adminHistoryTab' || page === 'deliveriesTab') {
        loadAdminTabs();
        showPage('cartContent');

        const allTabs = document.querySelectorAll('#cartContent .tab-card');
        const targetTabBtn = Array.from(allTabs).find(b => b.dataset.tab === page);

        if (targetTabBtn) {
          // ✅ If the deliveries tab is clicked, activate ALL tabs
          if (targetTabBtn.dataset.tab === 'deliveriesTab') {
            allTabs.forEach(b => b.classList.add('active'));
          } else {
            // Otherwise, activate only the selected tab
            allTabs.forEach(b => b.classList.remove('active'));
            targetTabBtn.classList.add('active');
          }

          // Update the content for the selected tab
          activateCartTab(targetTabBtn.dataset.tab);
        }
      }
    };
  });
}

function setupApplyForm(user) {
  const nameInput = document.getElementById('applyName');
  const reasonInput = document.getElementById('applyReason');
  const submitBtn = document.getElementById('applySubmitBtn');

  if (!submitBtn) return; // safety guard

  // 🔹 Auto-fill name from Firebase or Auth user
  if (nameInput) {
    if (user?.displayName) {
      nameInput.value = user.displayName;
    } else if (user?.uid) {
      database.ref('users/' + user.uid + '/name').once('value').then(snap => {
        nameInput.value = snap.val() || '';
      });
    }
  }

  // ⛔ Avoid double-binding
  if (submitBtn.dataset.bound === 'true') return;
  submitBtn.dataset.bound = 'true';

  // ✅ Click event handler
  submitBtn.addEventListener('click', async () => {
    const uid = auth.currentUser?.uid || user?.uid;

    if (!uid) {
      Swal.fire('Error', 'You must be logged in first.', 'error');
      return;
    }

    const name = nameInput?.value?.trim() || '';
    const reason = reasonInput?.value?.trim() || '';

    if (!reason) {
      Swal.fire('Required', 'Please enter your reason or business information.', 'warning');
      return;
    }

    // 🟢 Confirm before submitting
    const confirm = await Swal.fire({
      title: 'Submit Application?',
      text: 'You are applying for the Wholesaler role (Buy & Sell access).',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Yes, Submit',
      cancelButtonText: 'Cancel'
    });

    if (!confirm.isConfirmed) return;

    const appRef = database.ref('applications/' + uid);

    try {
      const snap = await appRef.once('value');

      if (snap.exists()) {
        const app = snap.val();

        if (app.status === 'pending') {
          Swal.fire('Already Submitted', 'You already have a pending application.', 'info');
          return;
        }

        if (app.status === 'approved') {
          Swal.fire('Already Approved', 'You are already a wholesaler.', 'success');
          return;
        }

        if (app.status === 'declined') {
          // Reapply logic
          submitApplication(uid, name, reason, appRef, true);
          return;
        }
      }

      // New application
      submitApplication(uid, name, reason, appRef, false);
    } catch (err) {
      Swal.fire('Error', err.message, 'error');
    }
  });
}


// ✅ Helper for writing to Firebase
function submitApplication(uid, name, reason, appRef, isReapply = false) {
  const appData = {
    uid,
    name,
    reason,
    status: 'pending',
    submittedAt: Date.now(),
    ...(isReapply ? { reapply: true } : {})
  };

  appRef.set(appData)
    .then(() => {
      Swal.fire(
        isReapply ? 'Reapplied!' : 'Application Sent!',
        isReapply
          ? 'Your reapplication has been sent for review.'
          : 'Your wholesaler application was successfully submitted.',
        'success'
      );
      document.getElementById('applyReason').value = '';
      loadInbox?.();
    })
    .catch(err => Swal.fire('Error', err.message, 'error'));
}


function showPage(page) {
  // Hide only main app pages
  const allMainPages = document.querySelectorAll('#mainApp > .app-block, #mainApp > .app-page');
  allMainPages.forEach(el => el.classList.add('hidden'));

  // Show target
  const target = document.getElementById(page);
  if (target) target.classList.remove('hidden');

  // Highlight active nav
  document.querySelectorAll('.bottom-nav .nav-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector(`.bottom-nav .nav-btn[data-page="${page}"]`);
  if (activeBtn) activeBtn.classList.add('active');
}



// ===== Home tabs =====
function attachHomeTabHandlers(){
  const homeBtns = $$('.home-tab-btn');
  homeBtns.forEach(b=>{
    b.onclick = ()=> {
      homeBtns.forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.tab;
      $$('#homeContent .home-section').forEach(s => s.classList.add('hidden'));
      const target = document.getElementById(tab);
      if(target) target.classList.remove('hidden');
    };
  });
}

// ===== Cart tab behavior =====
function attachCartTabHandlers(){
  const cartTabs = document.querySelectorAll('.cart-tabs-visual .tab-card.user-card');
  const cartContents = document.querySelectorAll('#cartContent .tab-content');

  cartTabs.forEach(tab=>{
    tab.addEventListener('click', () => {
      // Remove active from all tabs
      cartTabs.forEach(t => t.classList.remove('active'));
      // Activate clicked tab
      tab.classList.add('active');

      const targetId = tab.getAttribute('data-tab');
      // Show the corresponding content
      cartContents.forEach(content => {
        if(content.id === targetId) content.classList.add('active');
        else content.classList.remove('active');
      });
    });
  });
}


// 📌 FIXED & SAFE Admin Tabs (does not affect auto-login)
function attachAdminTabHandlers() {
  const adminTabs = document.querySelectorAll('#adminAccountTabs .tab-card');
  const adminContents = document.querySelectorAll('#adminContent .tab-content');

  // 🧩 Guard: ensure admin UI exists (avoid breaking non-admin sessions)
  if (!adminTabs.length || !adminContents.length) return;

  adminTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // 🔹 Reset all tabs and contents
      adminTabs.forEach(t => t.classList.remove('active'));
      adminContents.forEach(c => c.classList.remove('active', 'hidden'));

      // 🔹 Activate clicked tab
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      const target = document.getElementById(targetId);
      if (target) {
        target.classList.add('active');
      }

      // 🔹 Load data for each specific tab safely
      try {
        switch (targetId) {
          case 'reportsTab':
            if (typeof loadReports === 'function') loadReports();
            break;
          case 'applicationsTab':
            if (typeof loadApplications === 'function') loadApplications();
            break;
          case 'onProcessTab':
            if (typeof loadOnProcess === 'function') loadOnProcess();
            break;
          case 'transactionsTab':
            if (typeof loadAdminHistory === 'function') loadAdminHistory();
            break;
        }
      } catch (err) {
        console.warn(`⚠️ Tab load error in ${targetId}:`, err);
      }
    });
  });

  // ✅ Auto-activate first tab only if admin is logged in
  // This prevents interference with auto-login or other roles
  firebase.auth().onAuthStateChanged(user => {
    if (user && window.currentUserRole === 'admin') {
      const firstTab = adminTabs[0];
      if (firstTab) firstTab.click();
    }
  });
}



// ===== Cart visual handlers =====
function attachCartVisualHandlers(){
  const cards = Array.from(document.querySelectorAll('#cartTabVisual .tab-card, #adminTabVisual .tab-card'));
  cards.forEach(c => {
    c.onclick = () => {
      cards.forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      const tab = c.dataset.tab;
      $$('#cartContent .tab-content').forEach(sec => sec.classList.remove('active'));
      const target = document.getElementById(tab);
      if(target) target.classList.add('active');
      if(tab === 'ordersTab' || tab === 'deliveriesTab' || tab === 'historyTab') {
        loadCart(auth.currentUser?.uid);
      }
      if(tab === 'onProcessTab' || tab === 'adminHistoryTab') {
        loadAdminTabs();
      }
    };
  });
}

// ===== User CART =====
function loadCart(uid){
  loadOrders(uid);
  loadDeliveries(uid);
  loadHistory(uid);
}

// ================= ORDERS =================
function loadOrders(uid) {
  ordersList.innerHTML = '';
  if (!uid) { 
    updateCartCounts(); 
    return; 
  }

  const ref = database.ref('orders/' + uid);
  if (listeners['orders_' + uid]) listeners['orders_' + uid].off();
  listeners['orders_' + uid] = ref;

  ref.on('value', snap => {
    ordersList.innerHTML = '';
    if (!snap.exists()) {
      ordersList.innerHTML = `<div class="empty-state">You don’t have any orders yet.</div>`;
      return;
    }

    snap.forEach(child => {
      const o = child.val();
      const id = child.key;
      const transactionId = o.transactionId || id;

      // 🟢 Auto-move to Deliveries when status = ItemOutForDelivery
      if (o.status === 'ItemOutForDelivery') {
        const deliveryRef = database.ref(`deliveries/${uid}/${id}`);
        const orderRef = database.ref(`orders/${uid}/${id}`);

        // Prevent re-trigger loop by checking if already moved
        deliveryRef.once('value', async snap => {
          if (!snap.exists()) {
            const deliveryData = {
              ...o,
              movedToDeliveryAt: Date.now(),
              viewType: currentUserRole || 'user',
            };
            try {
              await deliveryRef.set(deliveryData);
              await orderRef.remove();
              pushToast(uid, `🚚 ${o.product || 'Item'} moved to Deliveries.`);
              pushTimeline(uid, id, `Item "${o.product || 'item'}" is now out for delivery.`);
            } catch (err) {
              console.warn('Auto-move to deliveries failed:', err);
            }
          }
        });
        return; // Skip showing this order since it’s being moved
      }

      // === NORMAL ORDERS RENDERING ===
      const div = document.createElement('div');
      div.className = 'orders-card';

      div.innerHTML = `
        <p><strong>Transaction ID:</strong> ${o.transactionId || id}</p>
        <h4 style="font-weight:bold; text-transform:uppercase;">${o.product || 'Item'}</h4>
        <p><strong>Qty:</strong> ${o.qty || ''} KG</p>
        ${o.price ? `<p><strong>Price per KG:</strong> ₱${o.price}</p>` : ''}
        ${o.price && o.qty ? `<h4>Total Price: ₱${Number(o.price) * Number(o.qty)}</h4>` : ''}
        ${o.deliveryPayment ? `<p><strong>Delivery Fee:</strong> ₱${o.deliveryPayment}</p>` : ''}
        ${o.destination ? `<p><strong>Destination:</strong> ${o.destination}</p>` : ''}
        ${o.ownerAddress ? `<p><strong>From:</strong> ${o.ownerAddress}</p>` : ''}
        <p><strong>Payment Method:</strong> ${o.paymentMethod || 'Cash on Delivery'}</p>
        ${(o.price && o.qty && o.deliveryPayment)
          ? `<h2>Total Payment: ₱${(Number(o.price) * Number(o.qty)) + Number(o.deliveryPayment)} (+delivery fee)</h2>`
          : ''}
        <p class="status ${o.status}">
          ${statusIcons[o.status] || '⏳'} ${o.status}
        </p>
        <div class="card-actions"></div>
      `;

      // =========================
      // 👑 OWNER (Seller) Controls
      // =========================
      const pendingStatuses = [
        'PendingApproval',
        'PendingSellerApproval',
        'PendingOrderApproval',
        'Pending',
        undefined,
        null,
        ''
      ];

      if (o.ownerId === auth.currentUser?.uid && pendingStatuses.includes(o.status)) {
        const actions = div.querySelector('.card-actions');

        // ✅ APPROVE button
        const approveBtn = document.createElement('button');
        approveBtn.className = 'round-btn approve';
        approveBtn.title = 'Approve Order';
        approveBtn.innerHTML = '<i class="fas fa-check"></i>';
        approveBtn.onclick = async () => {
          try {
            const res = await Swal.fire({
              title: 'Approve this order for delivery?',
              text: 'This will make it available for drivers to claim.',
              icon: 'question',
              showCancelButton: true,
              confirmButtonText: 'Approve'
            });
            if (!res.isConfirmed) return;

            await sellerApproveOrder(transactionId, o);
            div.remove();
          } catch (err) {
            console.error('Approve error:', err);
            Swal.fire('Error', err.message || 'Something went wrong while approving.', 'error');
          }
        };

        // ❌ DECLINE button
        const declineBtn = document.createElement('button');
        declineBtn.className = 'round-btn decline';
        declineBtn.title = 'Decline Order';
        declineBtn.innerHTML = '<i class="fas fa-times"></i>';
        declineBtn.onclick = async () => {
          const { value: reason } = await Swal.fire({
            title: 'Reason for Decline',
            input: 'text',
            inputPlaceholder: 'Enter reason...',
            showCancelButton: true
          });
          if (!reason) return;

          const declined = {
            ...o,
            status: 'Declined',
            declineReason: reason,
            declinedAt: Date.now(),
          };

          const updates = {};
          updates[`history/${o.ownerId}/${transactionId}`] = declined;
          updates[`history/${o.buyerId}/${transactionId}`] = declined;
          updates[`orders/${o.ownerId}/${transactionId}`] = null;
          updates[`orders/${o.buyerId}/${transactionId}`] = null;

          await database.ref().update(updates);

          pushToast(o.buyerId, `🚫 Your order for ${o.product} was declined: ${reason}`);
          pushTimeline(o.buyerId, transactionId, `Order for ${o.product} declined. Reason: ${reason}`);

          div.remove();
          Swal.fire('Declined', 'Order moved to history.', 'info');
        };

        actions.appendChild(approveBtn);
        actions.appendChild(declineBtn);
      }

      // =========================
      // 👤 BUYER View Only
      // =========================
      if (o.buyerId === auth.currentUser?.uid) {
        const actions = div.querySelector('.card-actions');
        actions.innerHTML = `<p style="font-size:12px; color:#888;">Waiting for seller action...</p>`;
      }

      ordersList.appendChild(div);
    });

    updateCartCounts();
  });
}



// =========================================================
// 🚚 UNIVERSAL DELIVERIES TAB (Driver / Buyer / Seller)
// ✅ Role-based visibility for delivery details
// ✅ Buyers/Sellers see only driver info
// ✅ Driver sees all (Buyer/Seller info + phones)
// ✅ Cleans completed deliveries and refreshes history
// =========================================================
async function loadDeliveries() {
  const deliveriesList = document.getElementById('deliveriesList');
  if (!deliveriesList || !auth.currentUser) return;

  const uid = auth.currentUser.uid;

  // 🔍 Fetch current user role
  let currentUserRole = 'buyer';
  try {
    const userSnap = await database.ref('users/' + uid).once('value');
    currentUserRole = (userSnap.val()?.role || '').toLowerCase();
  } catch (err) {
    console.warn('Failed to get user role:', err);
  }

  const ref = database.ref(`deliveries/${uid}`);

  if (listeners[`deliveries_${uid}`]) {
    try { listeners[`deliveries_${uid}`].off(); } catch {}
  }
  listeners[`deliveries_${uid}`] = ref;

  deliveriesList.innerHTML = `<div class="loading-state">Loading your deliveries...</div>`;

  ref.on('value', async (snap) => {
    deliveriesList.innerHTML = '';

    if (!snap.exists()) {
      deliveriesList.innerHTML = `<div class="empty-state">No deliveries assigned yet.</div>`;
      return;
    }

    const data = snap.val();
    const keys = Object.keys(data).reverse();
    const cleanup = {};
    let count = 0;

    const removeStatuses = ['Completed', 'FailedDelivery', 'deliverysuccess', 'deliveryfailed'];
    const activeStatuses = ['ItemOutForDelivery', 'OnDelivery', 'DeliveredPendingAdmin'];

    for (const id of keys) {
      const d = data[id];
      if (!d) continue;

      const status = (d.status || '').trim();
      if (removeStatuses.includes(status)) {
        cleanup[`deliveries/${uid}/${id}`] = null;
        continue;
      }
      if (!activeStatuses.includes(status)) continue;

      count++;

      const price = Number(d.price) || 0;
      const qty = Number(d.qty) || 0;
      const deliveryFee = Number(d.deliveryFee) || 0;
      const deliveryPayment = Number(d.deliveryPayment) || 0;
      const total = (price * qty) + deliveryFee + deliveryPayment;

      // 🧾 Base info (common for all)
      let content = `
        <div>
          <p><strong>Transaction ID:</strong> ${d.transactionId || id}</p>
          <h4 style="font-weight:bold;text-transform:uppercase;">${d.product || 'Item'}</h4>
          <p><strong>Qty:</strong> ${qty} ${price ? '| ₱' + price.toLocaleString() : ''}</p>
      `;

      // =========================================================
      // 👤 BUYER / SELLER VIEW (only driver info)
      // =========================================================
      if (currentUserRole === 'buyer' || currentUserRole === 'seller' || currentUserRole === 'wholesaler') {
        content += `
          <p><strong>Driver:</strong> ${d.driverName || 'Not Assigned'}</p>
          <p><strong>Driver Phone:</strong> ${d.driverPhone || 'N/A'}</p>
          <p><strong>Status:</strong> ${status}</p>
          <h3 style="color:green;">💰 Total: ₱${total.toLocaleString()}</h3>
        `;
      }

      // =========================================================
      // 🚚 DRIVER VIEW (show buyer/seller names, phones, addresses)
      // =========================================================
      else if (currentUserRole === 'driver' || currentUserRole === 'driverin' || currentUserRole === 'driverout') {
        content += `
          <div style="margin-top:5px;">
            <p><strong>FROM (Seller):</strong> ${d.ownerName || 'N/A'}</p>
            <p>📞 ${d.ownerPhone || 'N/A'}</p>
            <p><strong>Address:</strong> ${d.ownerAddress || 'Unknown Address'}</p>
          </div>
          <div style="margin-top:5px;">
            <p><strong>TO (Buyer):</strong> ${d.buyerName || 'N/A'}</p>
            <p>📞 ${d.buyerPhone || 'N/A'}</p>
            <p><strong>Address:</strong> ${d.buyerAddress || d.destination || 'Unknown Address'}</p>
          </div>
          <p><strong>Status:</strong> ${status}</p>
          <h3 style="color:green;">💰 Total: ₱${total.toLocaleString()}</h3>
        `;
      }

      content += `</div>
        <button class="round-btn timeline-btn" title="View Timeline">
          <i class="fas fa-stream"></i>
        </button>
      `;

      const div = document.createElement('div');
      div.className = 'orders-card';
      div.innerHTML = content;

      // 📜 Timeline modal
      const tl = div.querySelector('.timeline-btn');
      if (tl) tl.onclick = () => showTimelineModal(d);

      // --- DRIVER ACTIONS ---
      const actions = document.createElement('div');
      actions.className = 'card-actions';

      if ((currentUserRole === 'driver' || currentUserRole === 'driverin' || currentUserRole === 'driverout') &&
          ['ItemOutForDelivery', 'OnDelivery'].includes(status)) {

        const successBtn = document.createElement('button');
        successBtn.className = 'round-btn admin-success';
        successBtn.textContent = 'Success';
        successBtn.onclick = () => finalizeDelivery(id, d, 'Delivered', successBtn);

        const failBtn = document.createElement('button');
        failBtn.className = 'round-btn admin-fail';
        failBtn.textContent = 'Failed';
        failBtn.onclick = () => finalizeDelivery(id, d, 'Failed', failBtn);

        actions.appendChild(successBtn);
        actions.appendChild(failBtn);
      } 
      else if (status === 'DeliveredPendingAdmin') {
        const pending = document.createElement('button');
        pending.className = 'round-btn info';
        pending.textContent = '⏳ Pending Admin';
        pending.disabled = true;
        actions.appendChild(pending);
      }

      div.appendChild(actions);
      deliveriesList.appendChild(div);
    }

    // 🧹 Cleanup completed/failed deliveries
    if (Object.keys(cleanup).length > 0) {
      await database.ref().update(cleanup);
      console.log(`🧹 Cleaned completed/failed deliveries for ${uid}`);
      if (typeof loadHistory === 'function') loadHistory();
    }

    if (count === 0) {
      deliveriesList.innerHTML = `<div class="empty-state">No active deliveries right now.</div>`;
    }

        // 🧹 Cleanup completed/failed deliveries
    if (Object.keys(cleanup).length > 0) {
      await database.ref().update(cleanup);
      console.log(`🧹 Cleaned completed/failed deliveries for ${uid}`);
      if (typeof loadHistory === 'function') loadHistory();
    }

    // ✅ Update badge counts correctly
    updateCartCounts();

    if (count === 0) {
      deliveriesList.innerHTML = `<div class="empty-state">No deliveries assigned yet.</div>`;
    }
    // 🧹 Cleanup completed/failed deliveries
    if (Object.keys(cleanup).length > 0) {
      await database.ref().update(cleanup);
      console.log(`🧹 Cleaned completed/failed deliveries for ${uid}`);
      if (typeof loadHistory === 'function') loadHistory();

      // 🧽 Clean empty driver/seller/buyer delivery branches
      const userRef = database.ref(`deliveries/${uid}`);
      const userSnap = await userRef.once('value');
      if (!userSnap.exists() || Object.keys(userSnap.val() || {}).length === 0) {
        await userRef.remove();
        console.log(`🧹 Removed empty deliveries branch for ${uid}`);
      }
    }

    // ✅ Update badge counts correctly
    if (typeof updateCartCounts === 'function') updateCartCounts();

    if (count === 0) {
      deliveriesList.innerHTML = `<div class="empty-state">No deliveries assigned yet.</div>`;
    }
  });
}




// ================= HISTORY =================
function loadHistory(uid) {
  historyList.innerHTML = '';
  if (!uid) { updateCartCounts(); return; }

  const ref = database.ref('history/' + uid);
  if (listeners['history_' + uid]) listeners['history_' + uid].off();
  listeners['history_' + uid] = ref;

  ref.on('value', snap => {
    historyList.innerHTML = '';

    if (!snap.exists()) {
      historyList.innerHTML = `<div class="empty-state">No past transactions yet.</div>`;
    } else {
      snap.forEach(child => {
        const h = child.val();
        const id = child.key;
        const div = document.createElement('div');
        div.className = 'orders-card';

        // 🧩 Build simplified display (Driver only)
        div.innerHTML = `
          <p><strong>Transaction ID:</strong> ${h.transactionId || id}</p>
          <h4 style="font-weight:bold; text-transform:uppercase;">${h.product || 'Item'}</h4>
          <p><strong>Qty:</strong> ${h.qty || ''}</p>
          ${h.price ? `<p><strong>Price per KG:</strong> ₱${h.price}</p>` : ''}
          ${h.price && h.qty ? `<h4><strong>Total Price:</strong> ₱${(h.price * h.qty).toLocaleString()}</h4>` : ''}
          ${h.destination ? `<p><strong>Destination:</strong> ${h.destination}</p>` : ''}

          ${h.driverName ? `<p><strong>Driver:</strong> ${h.driverName}</p>` : ''}

          ${h.deliveryFee ? `<p><strong>Delivery Fee:</strong> ₱${h.deliveryFee}</p>` : ''}
          ${h.deliveryPayment ? `<p><strong>Delivery Payment:</strong> ₱${h.deliveryPayment}</p>` : ''}

          ${
            (h.price && h.qty && h.deliveryPayment)
              ? `<h2><strong>Total Payment:</strong> ₱${((h.price * h.qty) + Number(h.deliveryPayment)).toLocaleString()} (+delivery fee)</h2>`
              : ''
          }

          <div class="card-actions">
            <button class="round-btn copy-id" data-id="${h.transactionId || id}" title="Copy Transaction ID">
              <i class="fas fa-copy"></i>
            </button>
            <button class="round-btn timeline-btn" data-id="${id}" title="View Timeline">
              <i class="fas fa-stream"></i>
            </button>
          </div>

          <p class="status ${h.status}" style="margin-top:5px;">
            ${statusIcons[h.status] || ''} ${h.status}
          </p>
        `;

// 📜 Timeline button handler (fixed)
const tlBtn = div.querySelector('.timeline-btn');
if (tlBtn) {
  tlBtn.onclick = e => {
    e.stopPropagation();
    const tid = h.transactionId || id;
    if (typeof showTimelineModal === 'function') {
      showTimelineModal(h);
    } else if (typeof openTimelineModal === 'function') {
      openTimelineModal(tid);
    } else {
      console.warn('⚠️ No timeline modal function found for', tid);
      Swal.fire('Notice', 'Timeline viewer not available right now.', 'info');
    }
  };
}

        historyList.appendChild(div);
      });
    }

    // 📋 Copy ID handler
    historyList.querySelectorAll('.copy-id').forEach(btn => {
      btn.onclick = e => {
        const tid = e.currentTarget.getAttribute('data-id');
        navigator.clipboard.writeText(tid).then(() => {
          Swal.fire('Copied!', 'Transaction ID copied.', 'success');
        });
      };
    });

    updateCartCounts();
  });
}

// ================= TIMELINE MODAL (UPDATED WITH COMPLETED AT) =================
function showTimelineModal(record) {
  // Remove existing modal to avoid duplicates
  document.querySelectorAll('.timeline-modal').forEach(m => m.remove());

  // 🔹 Status color and icon maps
  const statusColors = {
    pending: "#f4b400",
    approved: "#007bff",
    forpickup: "#007bff",
    pickup: "#007bff",
    ondelivery: "#ff8c00",
    delivered: "#28a745",
    success: "#28a745",
    completed: "#28a745",
    canceled: "#dc3545",
    declined: "#6c757d",
    failed: "#b02a37",
    onprocess: "#17a2b8",
    pendingapproval: "#f4b400",
    itemoutfordelivery: "#ff8c00",
    deliverysuccess: "#28a745",
    deliveryfailed: "#b02a37",
  };

  const statusIcons = {
    pending: "⏳",
    approved: "✅",
    forpickup: "📦",
    pickup: "🚚",
    ondelivery: "🚚",
    delivered: "📬",
    success: "🏁",
    completed: "🏁",
    canceled: "❌",
    declined: "🚫",
    failed: "⚠️",
    onprocess: "⚙️",
    pendingapproval: "⏳",
    itemoutfordelivery: "🚛",
    deliverysuccess: "🎉",
    deliveryfailed: "💥",
  };

  // ✅ Collect timeline steps safely
  const steps = [];

  const addStep = (label, time) => {
    if (time) steps.push({ status: label, timestamp: time });
  };

  // Standard lifecycle events
  addStep("Created", record.createdAt);
  addStep("Approved", record.approvedAt);
  addStep("Picked Up", record.pickedUpAt);
  addStep("Out for Delivery", record.ondeliveryAt);
  addStep("Delivered", record.deliveredAt);
  addStep("Completed", record.finishedAt || record.completedAt);
  addStep("Canceled", record.canceledAt);
  addStep("Declined", record.declinedAt);
  addStep("Failed", record.failedAt);
  addStep("Finalized", record.finalizedAt);

  // Include any dynamic history array
  if (Array.isArray(record.statusHistory)) {
    record.statusHistory.forEach(s => {
      if (s?.status) steps.push(s);
    });
  }

  // Sort steps by time ascending
  steps.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // Remove near-duplicate entries (within 30s)
  const uniqueSteps = [];
  steps.forEach(step => {
    const s = (step.status || "").toLowerCase();
    const t = step.timestamp || 0;
    const duplicate = uniqueSteps.some(prev =>
      (prev.status || "").toLowerCase() === s &&
      Math.abs((prev.timestamp || 0) - t) < 30000
    );
    if (!duplicate) uniqueSteps.push(step);
  });

  // ✅ Build the visual timeline
  let timelineHtml = "";
  if (uniqueSteps.length > 0) {
    uniqueSteps.forEach(step => {
      const s = (step.status || "").toLowerCase();
      const color = statusColors[s] || "#888";
      const icon = statusIcons[s] || "📍";
      const ts = step.timestamp
        ? new Date(step.timestamp).toLocaleString("en-PH", {
            hour12: true,
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "No timestamp";

      timelineHtml += `
        <div class="timeline-step" 
             style="border-left:4px solid ${color}; padding-left:10px; margin-bottom:10px;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:16px;">${icon}</span>
            <strong style="color:${color}; text-transform:capitalize;">${step.status}</strong>
          </div>
          <small style="color:#666;">${ts}</small>
        </div>
      `;
    });
  } else {
    timelineHtml = `<p style="text-align:center; color:#999;">No timeline data available.</p>`;
  }

  // ✅ Completed At (Summary Header)
  let completedHeader = "";
  if (record.completedAt || record.finishedAt) {
    const completedTime = new Date(record.completedAt || record.finishedAt).toLocaleString("en-PH", {
      hour12: true,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    completedHeader = `
      <div style="background:#e8f7e9; border-left:4px solid #3bb273; padding:10px 12px; border-radius:6px; margin-bottom:10px;">
        <strong>✅ Completed At:</strong> ${completedTime}
      </div>
    `;
  }

  // ✅ Create modal container
  const modal = document.createElement("div");
  modal.className = "modal show timeline-modal";
  modal.innerHTML = `
    <div class="modal-content" style="max-width:420px; pointer-events:auto;">
      <h3 style="margin-bottom:10px;">📜 Transaction Timeline</h3>
      <div class="modal-body" style="max-height:400px; overflow-y:auto; padding-right:6px;">
        ${completedHeader}
        ${timelineHtml}
      </div>
      <div class="modal-actions" style="text-align:right; margin-top:15px;">
        <button class="cta-button small close-modal">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // ✅ Modal close events
  const closeBtn = modal.querySelector(".close-modal");
  closeBtn.addEventListener("click", e => {
    e.stopPropagation();
    modal.remove();
  });

  modal.addEventListener("click", e => {
    if (e.target === modal) modal.remove();
  });
}

// ===== Stocks / Buy / Sell logic =====
function loadStocksAndSellList(uid){
  const stocksRef = database.ref('stocks');
  if(listeners['stocks']) listeners['stocks'].off();
  listeners['stocks'] = stocksRef;

  stocksRef.on('value', snap=>{
    homeBuyList.innerHTML = '';
    homeSellList.innerHTML = '';
    let anyBuy = false;
    let anySell = false;

    snap.forEach(child=>{
      const st = child.val();
      const sid = child.key;

      // ✅ Show only approved stocks
      if(st.status !== 'approved') return;

      // ✅ Check expiry (auto-remove if expired)
      if(st.expiryAt && Date.now() >= st.expiryAt){
        const expiredData = { ...st, status: 'expired', expiredAt: Date.now() };
        database.ref('stocks/'+sid).remove().catch(()=>{});
        database.ref('expiredStocks/'+sid).set(expiredData).catch(()=>{});
        return;
      }

      // Build card (handles visible countdown timer itself)
      const div = buildStockCard(st, sid, uid && (st.ownerId === uid || st.owner === uid));

      if(uid && (st.ownerId === uid || st.owner === uid)){
        anySell = true;
        homeSellList.appendChild(div);
      } else {
        anyBuy = true;
        homeBuyList.appendChild(div);
      }
    });

    homeBuyEmpty && homeBuyEmpty.classList.toggle('hidden', anyBuy);
    homeSellEmpty && homeSellEmpty.classList.toggle('hidden', anySell);
  });
}


// ✅ Helper: Format countdown text
function formatCountdown(expiryAt){
  const diff = expiryAt - Date.now();
  if(diff <= 0) return "Expired";
  const hrs = Math.floor(diff / (1000*60*60));
  const mins = Math.floor((diff % (1000*60*60)) / (1000*60));
  return `${hrs}h ${mins}m left`;
}


function buildStockCard(st, sid, isOwner) {
  const div = document.createElement('div');
  div.className = 'product-card';

  const info = document.createElement('div');
  info.className = 'product-info';

  // 🟢 Base Info
  let html = `
    <div class="product-row">
      <strong>${st.product}</strong>
      <span class="badge price">₱${st.price}/kg</span>
    </div>
    <div>Seller: ${st.ownerName || st.owner || 'Seller'}</div>
    <div>Stock: <span class="badge stock">${st.qty} kg</span></div>
  `;

  // 🟡 Total price (qty * price)
  if (st.price && st.qty) {
    const total = st.price * st.qty;
  }

  // 🟠 Delivery info
  if (st.deliveryFee) {
    html += `<p><strong>Delivery Fee:</strong> ₱${st.deliveryFee}</p>`;
  }
  if (st.deliveryPayment) {
    html += `<p><strong>Delivery Payment:</strong> ₱${st.deliveryPayment}</p>`;
  }

  // 🔵 Grand total (items + delivery + payment)
  if (st.price && st.qty) {
    const totalPayment = (st.price * st.qty) + (Number(st.deliveryFee) || 0) + (Number(st.deliveryPayment) || 0);
  }

  info.innerHTML = html;

  // ✅ Timer
  if (st.expiryAt) {
    const timerEl = document.createElement('div');
    timerEl.className = "stock-timer";
    timerEl.style.fontWeight = "bold";
    info.appendChild(timerEl);

    function expireStock() {
      const expiredData = { ...st, status: 'expired', expiredAt: Date.now() };
      database.ref('stocks/' + sid).remove().catch(()=>{});
      database.ref('expiredStocks/' + sid).set(expiredData).catch(()=>{});
      div.remove();
      addActivity(`⏰ Stock expired: ${st.product} (Seller: ${st.ownerName||''})`);
    }

    function updateTimer() {
      const remaining = st.expiryAt - Date.now();
      if (remaining <= 0) {
        expireStock();
        clearInterval(interval);
        return;
      }
      const hrs = Math.floor(remaining / (1000 * 60 * 60));
      const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
      timerEl.textContent = `⏳ ${hrs}h ${mins}m left`;
      timerEl.style.color = remaining <= 30 * 60 * 1000 ? "red" : "green";
    }

    updateTimer();
    const interval = setInterval(() => {
      if (!document.body.contains(div)) {
        clearInterval(interval);
        return;
      }
      updateTimer();
    }, 30000);
  }

  // 🔘 Actions
  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.flexDirection = 'column';
  actions.style.gap = '8px';

  if (currentUserRole === 'admin') {
    const adminRemove = document.createElement('button');
    adminRemove.className = 'round-button';
    adminRemove.textContent = 'Remove';
    adminRemove.addEventListener('click', () => {
      Swal.fire({
        title: `Remove stock?`,
        text: `Do you really want to remove ${st.product} (Qty: ${st.qty}) from marketplace?`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, remove',
        cancelButtonText: 'Cancel'
      }).then(res => {
        if (res.isConfirmed) {
          database.ref('stocks/' + sid).remove().then(() => {
            addActivity(`🗑️ Admin removed stock: ${st.product} (Seller: ${st.ownerName||''})`);
            Swal.fire('Removed','The stock has been removed.','success');
          });
        }
      });
    });
    actions.appendChild(adminRemove);

  } else if (isOwner) {
    const edit = document.createElement('button');
    edit.className = 'round-button';
    edit.textContent = 'Remove';
    edit.addEventListener('click', () => {
      Swal.fire({
        title: 'Remove stock?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Remove'
      }).then(res => {
        if (res.isConfirmed) {
          database.ref('stocks/' + sid).remove();
        }
      });
    });
    actions.appendChild(edit);

  } else {
    const buy = document.createElement('button');
    buy.className = 'round-button';
    buy.textContent = 'Buy';
    buy.addEventListener('click', () => openCheckoutModal(st, sid));
    actions.appendChild(buy);

    const reportBtn = document.createElement('button');
    reportBtn.className = 'round-btn';
    reportBtn.title = 'Report User';
    reportBtn.innerHTML = `<i class="fas fa-flag"></i>`;
    reportBtn.addEventListener('click', () => {
      Swal.fire({
        title: 'Report User',
        input: 'textarea',
        inputLabel: 'Reason for report',
        inputPlaceholder: 'Enter reason...',
        showCancelButton: true,
        confirmButtonText: 'Submit'
      }).then(result => {
        if (result.isConfirmed) {
          const report = {
            reportedId: st.ownerId,
            reason: result.value,
            status: 'pending',
            timestamp: Date.now(),
            reporter: auth.currentUser?.uid || 'anonymous'
          };
          database.ref('reports').push(report);
          Swal.fire('Reported!','Your report has been submitted.','success');
        }
      });
    });
    actions.appendChild(reportBtn);
  }

  div.appendChild(info);
  div.appendChild(actions);
  return div;
}

// ======================= BUY / CHECKOUT MODAL =======================

// Global variable to store selected product
let checkoutProduct = null;

function openCheckoutModal(st, sid) {
  checkoutProduct = { ...st, sid };

  // ✅ Safe DOM updates
  if (checkoutProductInfo)
    checkoutProductInfo.textContent = `${st.product} — ₱${st.price} / kg`;

  if (checkoutQty) checkoutQty.value = 1;

  // Auto-fill destination with user's saved address
  const userAddress = document.getElementById("profileAddressDisplay")?.innerText.trim();
  if (checkoutDestination) checkoutDestination.value = userAddress || "";

  if (checkoutMethod) checkoutMethod.value = "Cash on Delivery";

  // ✅ Show modal
  if (checkoutModal) {
    checkoutModal.classList.remove("hidden");
    setTimeout(() => checkoutModal.classList.add("show"), 10);
  }

  // ✅ Hide bottom navigation when modal is visible
  if (bottomNav) bottomNav.classList.add("hidden");

  // Optional wrapper
  if (checkoutDestinationWrap) checkoutDestinationWrap.style.display = "";
}

// =====================================================
// ❌ Cancel Checkout — Close modal and reset
// =====================================================
if (cancelCheckoutBtn) {
  cancelCheckoutBtn.addEventListener("click", () => {
    if (checkoutModal) {
      checkoutModal.classList.remove("show");
      setTimeout(() => checkoutModal.classList.add("hidden"), 250);
    }

    // ✅ Restore bottom nav
    if (bottomNav) bottomNav.classList.remove("hidden");

    checkoutProduct = null;
  });
}

// -------------------------
// 🛒 Buyer: Confirm Checkout (Fixed for stocks/ path)
// -------------------------
if (confirmCheckoutBtn) {
  confirmCheckoutBtn.addEventListener("click", async () => {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) {
        Swal.fire("Not Logged In", "Please login first.", "warning");
        return;
      }

      const qty = Number(checkoutQty?.value) || 1;
      const dest = checkoutDestination?.value.trim() || "";

      if (!checkoutProduct || !checkoutProduct.sid) {
        Swal.fire("Error", "No product selected.", "error");
        return;
      }

      const stockRef = database.ref(`stocks/${checkoutProduct.sid}`);
      const stockSnap = await stockRef.once("value");
      if (!stockSnap.exists()) {
        Swal.fire("Unavailable", "This item is no longer available.", "warning");
        return;
      }

      const stock = stockSnap.val();
      const currentStock = Number(stock.qty) || 0;

      if (currentStock <= 0) {
        Swal.fire("Out of Stock", "This item is out of stock.", "warning");
        await stockRef.remove(); // 🧹 remove from listing
        return;
      }

      if (qty > currentStock) {
        Swal.fire("Insufficient Stock", `Only ${currentStock} left in stock.`, "warning");
        return;
      }

      // 🔹 Fetch buyer & seller info
      const [buyerSnap, ownerSnap] = await Promise.all([
        database.ref("users/" + uid).once("value"),
        database.ref("users/" + stock.ownerId).once("value")
      ]);
      const buyer = buyerSnap.val() || {};
      const owner = ownerSnap.val() || {};

      // 🔹 Generate transaction ID
      const counterSnap = await database.ref("orderCounter").transaction(n => (n || 0) + 1);
      const counter = counterSnap.snapshot.val();
      const transactionId = `ORD${String(counter).padStart(3, "0")}`;

// 🔹 Build order object 
const payload = {
  transactionId,
  stockId: checkoutProduct.sid,
  product: stock.product,
  price: Number(stock.price) || 0,
  qty,
  subtotal: (Number(stock.price) || 0) * qty,
  ownerId: stock.ownerId,
  ownerName: stock.ownerName || "",
  ownerAddress: stock.ownerAddress || "",
  buyerId: uid,
  buyerName: buyer.name || "",
  buyerAddress: buyer.address || "",
  buyerPhone: buyer.phone || "",   // ✅ added this line
  destination: dest || buyer.address || "",
  type: "order",
  status: "PendingSellerApproval",
  paymentMethod: "Cash on Delivery",
  createdAt: Date.now()
};


      // 🔹 Deduct stock
      const remaining = currentStock - qty;
      if (remaining <= 0) {
        await stockRef.remove();
      } else {
        await stockRef.update({ qty: remaining });
      }

      // 🔹 Save order under both buyer & seller
      await Promise.all([
        database.ref(`orders/${payload.buyerId}/${transactionId}`).set(payload),
        database.ref(`orders/${payload.ownerId}/${transactionId}`).set(payload),
        database.ref(`pendingOrders/${transactionId}`).set(payload)
      ]);

      Swal.fire("Order Submitted!", `Transaction ID: ${transactionId}`, "success");
      checkoutModal?.classList.remove("show");
      setTimeout(() => checkoutModal?.classList.add("hidden"), 250);
      if (bottomNav) bottomNav.classList.remove("hidden");
      checkoutProduct = null;

    } catch (err) {
      console.error("Checkout error:", err);
      Swal.fire("Error", err.message || "Something went wrong during checkout.", "error");
    }
  });
}

// =====================================================
// 🧱 Seller Approval / Decline Flow
// =====================================================
async function loadSellerOrders() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const list = document.getElementById("sellerOrdersList");
  if (!list) return;
  list.innerHTML = "";

  const ref = database.ref("orders/" + uid);
  if (listeners["sellerOrders"]) listeners["sellerOrders"].off();
  listeners["sellerOrders"] = ref;

  ref.on("value", (snap) => {
    list.innerHTML = "";
    if (!snap.exists()) {
      list.innerHTML = `<div class="empty-state">No current orders.</div>`;
      return;
    }

    snap.forEach((child) => {
      const o = child.val();
      const id = child.key;

      const div = document.createElement("div");
      div.className = "orders-card";
      div.innerHTML = `
        <div>
          <h4>${o.product}</h4>
          <p><strong>Qty:</strong> ${o.qty}</p>
          <p><strong>Buyer:</strong> ${o.buyerName || "Unknown"}</p>
          <p><strong>Phone:</strong> ${o.buyerPhone || "N/A"}</p>
          <p><strong>Address:</strong> ${o.buyerAddress || "N/A"}</p>
          <p><strong>Status:</strong> ${o.status}</p>
        </div>
      `;

      if (o.status === "PendingApproval") {
        const actions = document.createElement("div");
        actions.className = "card-actions";

        // ✅ APPROVE ORDER
        const approveBtn = document.createElement("button");
        approveBtn.className = "round-btn admin-approve";
        approveBtn.innerHTML = `<i class="fas fa-check"></i>`;
        approveBtn.title = "Approve Order";

        approveBtn.onclick = async () => {
          Swal.fire({
            title: "Approve this order?",
            text: "This will move the order to Pending Deliveries.",
            icon: "question",
            showCancelButton: true,
            confirmButtonText: "Approve",
          }).then(async (res) => {
            if (!res.isConfirmed) return;

            const deliveryData = {
              ...o,
              status: "WaitingForDriver",
              approvedAt: Date.now(),
              approvedByOwner: uid,
            };

            const updates = {};
            updates[`pendingDeliveries/${id}`] = deliveryData;
            updates[`orders/${uid}/${id}/status`] = "Approved";
            updates[`orders/${o.buyerId}/${id}/status`] = "Approved";
            updates[`pendingStock/${id}/status`] = "Approved";
            await database.ref().update(updates);

            // 🔔 Notifications + Timeline
            pushToast(o.buyerId, `Your order ${o.transactionId} was approved by the seller.`);
            pushToast("admin", `Seller approved order ${o.transactionId}.`);
            pushTimeline(o.buyerId, id, "Your order has been approved and will be delivered soon.");
            pushTimeline(uid, id, "You approved an order and it is now waiting for a driver.");
            pushTimeline("admin", id, "Seller approved order and moved it to deliveries.");
            notifyDrivers(`New delivery task available: ${o.product}`);

            Swal.fire("Approved", "Order moved to Pending Deliveries.", "success");
          });
        };

        // ❌ DECLINE ORDER
        const declineBtn = document.createElement("button");
        declineBtn.className = "round-btn admin-decline";
        declineBtn.innerHTML = `<i class="fas fa-times"></i>`;
        declineBtn.title = "Decline Order";

        declineBtn.onclick = () => {
          Swal.fire({
            title: "Reason for Decline",
            input: "text",
            inputPlaceholder: "Enter reason...",
            showCancelButton: true,
          }).then(async (res) => {
            if (!res.isConfirmed || !res.value) return;
            const reason = res.value;

            const declined = {
              ...o,
              status: "DeclinedBySeller",
              reason,
              declinedAt: Date.now(),
            };

            const updates = {};
            updates[`history/${uid}/${id}`] = declined;
            updates[`history/${o.buyerId}/${id}`] = declined;
            updates[`pendingStock/${id}`] = declined;
            updates[`orders/${uid}/${id}`] = null;
            updates[`orders/${o.buyerId}/${id}`] = null;
            await database.ref().update(updates);

            // 🔔 Notifications + Timeline
            pushToast(o.buyerId, `Your order ${o.transactionId} was declined. Reason: ${reason}`);
            pushToast("admin", `Seller declined order ${o.transactionId}.`);
            pushTimeline(o.buyerId, id, `Your order was declined. Reason: ${reason}`);
            pushTimeline(uid, id, `You declined an order. Reason: ${reason}`);
            pushTimeline("admin", id, `Seller declined order ${o.transactionId}.`);

            Swal.fire("Declined", "Order moved to History.", "info");
          });
        };

        actions.appendChild(approveBtn);
        actions.appendChild(declineBtn);
        div.appendChild(actions);
      }

      list.appendChild(div);
      if (p.qty <= 0) {
  database.ref('stocks/' + id).remove();
  return; // skip showing out-of-stock items
}

    });
  });
}

// =====================================================
// 🔔 Toast + Timeline Helpers
// =====================================================
function pushToast(userId, message) {
  if (!userId) return;
  database.ref("notifications/" + userId).push({
    message,
    createdAt: Date.now(),
  });
}

function pushTimeline(userId, transactionId, message) {
  if (!userId) return;
  database.ref("timeline/" + userId).push({
    transactionId,
    message,
    time: Date.now(),
  });
}

async function notifyDrivers(message) {
  const snap = await database.ref("users").orderByChild("role").equalTo("driver").once("value");
  snap.forEach((u) => pushToast(u.key, message));
}

// =====================================================
// 🧭 Real-Time Toast Listener for Logged-in User
// =====================================================
function listenForToasts() {
  const uid = auth.currentUser?.uid || "admin";
  const ref = database.ref("notifications/" + uid);
  if (listeners["toastNotifications"]) listeners["toastNotifications"].off();
  listeners["toastNotifications"] = ref;

  ref.on("child_added", (snap) => {
    const data = snap.val();
    if (!data) return;
    Toastify({
      text: data.message,
      duration: 5000,
      gravity: "top",
      position: "right",
      backgroundColor: "#333",
    }).showToast();

    database.ref("notifications/" + uid + "/" + snap.key).remove();
  });
}

// ================================
// Tab switching logic for admin
// ================================
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.tab-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      const target = card.dataset.tab;

      // Hide all tabs
      document.querySelectorAll('.tab-content').forEach(c=> c.classList.remove('active'));
      document.getElementById(target).classList.add('active');

      // Show search only if Transactions tab
      if(target === 'adminHistoryTab'){
        document.getElementById('adminSearchWrap').style.display = 'block';
      } else {
        document.getElementById('adminSearchWrap').style.display = 'none';
      }
    });
  });
});

// ===== Sell action (Farmer submits stock for admin approval with transaction ID) =====
if (sellBtn) sellBtn.addEventListener('click', async () => {
  const name = sellProduct.value.trim();
  const qty = Number(sellQty.value) || 0;
  const price = Number(sellPrice.value) || 0;
  const uid = auth.currentUser?.uid;

  if (!uid) {
    Swal.fire('Not logged in', 'Please login first', 'warning');
    return;
  }

  if (!name || qty <= 0 || price <= 0) {
    Swal.fire('Error', 'Please enter product, quantity, and price.', 'error');
    return;
  }

  try {
    const snap = await database.ref('users/' + uid).once('value');
    const u = snap.val() || {};

    const transactionId = await generateTransactionId('stock');
    const itemId = database.ref().push().key;

    const obj = {
      id: itemId,
      product: name,
      qty,
      price,
      ownerId: uid,
      ownerName: u.name || u.email || 'Seller',
      ownerPhone: u.phone || '',
      ownerAddress: u.address || '',
      createdAt: Date.now(),
      status: 'PendingApproval',
      type: 'stock',
      transactionId
    };

    await database.ref('pendingStock/' + itemId).set(obj);

    Swal.fire('Submitted', 'Your item is waiting for admin approval.', 'success');
    sellProduct.value = '';
    sellQty.value = '';
    sellPrice.value = '';
  } catch (err) {
    Swal.fire('Error', err.message, 'error');
  }
});

// ===== Delivery request =====
if (deliverBtn) deliverBtn.addEventListener('click', ()=>{
  const product = deliverProduct.value.trim();
  const qty = Number(deliverQty.value) || 0;
  const destination = deliverDestination.value.trim();
  const receiverName = document.getElementById('deliverReceiverName')?.value.trim() || '';
  const receiverPhone = document.getElementById('deliverReceiverPhone')?.value.trim() || '';
  const receiverAddress = document.getElementById('deliverReceiverAddress')?.value.trim() || '';
  const uid = auth.currentUser?.uid;

  if(!product || !qty || !destination || !receiverName || !receiverPhone || !receiverAddress){
    Swal.fire('Missing Fields','Please complete all fields (including receiver info)','warning');
    return;
  }
  if(!uid){
    Swal.fire('Error','Not logged in','error');
    return;
  }

  database.ref('users/'+uid).once('value').then(userSnap=>{
    const buyer = userSnap.val() || {};

    // 🔹 Generate sequential DELIVERY transaction ID
    return database.ref('deliveryCounter').transaction(n => (n || 0) + 1).then(counterSnap=>{
      const counter = counterSnap.snapshot.val();
      const id = `DEL${String(counter).padStart(3,'0')}`;

      const payload = {
        product,
        qty,
        destination,
        userId: uid,
        type: 'delivery',
        status: 'pending',   // stays pending until admin approves
        createdAt: Date.now(),
        buyerName: buyer.name || '',
        buyerPhone: buyer.phone || '',
        buyerAddress: buyer.address || '',
        receiverName,
        receiverPhone,
        receiverAddress,
        transactionId: id
      };

      // ✅ Save request to admin’s "pendingDeliveries"
      return database.ref('pendingDeliveries/'+id).set(payload).then(()=>{
        // ✅ Also save under buyer’s Deliveries as "pending"
        return database.ref('deliveries/'+uid+'/'+id).set(payload);
      }).then(()=>{
        Swal.fire(
          'Delivery Request Submitted',
          `Your delivery is waiting for admin approval. Transaction ID: ${id}`,
          'success'
        );

        // clear inputs
        deliverProduct.value='';
        deliverQty.value='';
        deliverDestination.value='';
        if(document.getElementById('deliverReceiverName')) document.getElementById('deliverReceiverName').value='';
        if(document.getElementById('deliverReceiverPhone')) document.getElementById('deliverReceiverPhone').value='';
        if(document.getElementById('deliverReceiverAddress')) document.getElementById('deliverReceiverAddress').value='';
      });
    });
  }).catch(err=> Swal.fire('Error', err.message, 'error'));
});
// ===== BUY ACTION (Customer or Wholesaler) =====
if (buyBtn) buyBtn.addEventListener('click', () => {
  const product = buyProduct.value.trim();
  const qty = Number(buyQty.value) || 0;
  const uid = auth.currentUser?.uid;
  const ownerId = buyProduct.dataset.ownerId;  // Farmer ID
  const ownerName = buyProduct.dataset.ownerName || '';

  if (!product || !qty) {
    Swal.fire('Missing Fields', 'Please complete all fields.', 'warning');
    return;
  }
  if (!uid) {
    Swal.fire('Error', 'You must be logged in to buy.', 'error');
    return;
  }

  // 🔹 Get buyer info
  database.ref('users/' + uid).once('value').then(userSnap => {
    const buyer = userSnap.val() || {};

    // 🔹 Generate sequential ORDER transaction ID (ORD001, ORD002, ...)
    return database.ref('orderCounter').transaction(n => (n || 0) + 1).then(counterSnap => {
      const counter = counterSnap.snapshot.val();
      const orderId = `ORD${String(counter).padStart(3, '0')}`;
      const itemKey = database.ref().push().key; // Firebase unique key

      const order = {
        product,
        qty,
        buyerId: uid,
        buyerName: buyer.name || '',
        buyerPhone: buyer.phone || '',
        buyerAddress: buyer.address || '',
        ownerId,
        ownerName,
        transactionId: orderId,
        createdAt: Date.now(),
        status: 'PendingOrderApproval',
        type: 'order'
      };

      // ✅ Save order for admin approval
      return database.ref('orders/' + itemKey).set(order).then(() => {
        // ✅ Remove from approvedStock (Buy tab)
        return database.ref('approvedStock/' + itemKey).remove();
      }).then(() => {
        Swal.fire(
          'Order Submitted',
          `Your order has been sent for admin approval. Transaction ID: ${orderId}`,
          'success'
        );
        buyProduct.value = '';
        buyQty.value = '';
      });
    });
  }).catch(err => Swal.fire('Error', err.message, 'error'));
});

// ===== Admin Tabs =====
function loadAdminTabs() {
  loadPendingStocks();      // Farmer stock approvals
  loadPendingOrders();      // Customer/wholesaler order approvals
  loadPendingDeliveries();  // Admin approval for deliveries
  loadOnProcess();          // Active deliveries
  loadAdminHistory();       // Completed & declined history
  loadAdminActivity();      // Admin activity logs
  loadApplications();       // ✅ Wholesaler applications
}


// ================= PENDING STOCKS & ORDERS =================
function loadPendingStocks() {
  const pendingList = document.getElementById('pendingAdminList');
  if (!pendingList) return;
  pendingList.innerHTML = '';

  const ref = database.ref('pendingStock');
  if (listeners['pendingStock']) listeners['pendingStock'].off();
  listeners['pendingStock'] = ref;

  ref.on('value', snap => {
    pendingList.innerHTML = '';
    let count = 0;

    if (!snap.exists()) {
      pendingList.innerHTML = `<div class="empty-state">No pending farmer stocks or orders.</div>`;
      return;
    }

    snap.forEach(child => {
      const p = child.val();
      const id = child.key;
      count++;

      const div = document.createElement('div');
      div.className = 'orders-card';

      const typeLabel = p.type === 'order' ? '🛒 Order Request' : '🌾 Farmer Stock';
      const statusText =
        p.type === 'order'
          ? 'Pending Seller Approval'
          : 'Pending Admin Approval';

      div.innerHTML = `
        <div>
          <p><strong>Transaction ID:</strong> ${p.transactionId || id}</p>
          <h4>${p.product}</h4>
          <p>Qty: ${p.qty} ${p.price ? '| ₱' + p.price : ''}</p>
          ${p.destination ? `<p><strong>Destination:</strong> ${p.destination}</p>` : ''}
          <p><strong>Type:</strong> ${typeLabel}</p>
          ${p.ownerName ? `<p><strong>Seller:</strong> ${currentUserRole === 'admin' || currentUserRole === 'driver' ? p.ownerName : 'Hidden'}</p>` : ''}
          ${p.buyerName ? `<p><strong>Buyer:</strong> ${currentUserRole === 'admin' || currentUserRole === 'driver' ? p.buyerName : 'Hidden'}</p>` : ''}
          <span class="status pending">⏳ ${statusText}</span>
        </div>
        <div class="card-actions">
          <button class="round-btn admin-approve" title="Approve"><i class="fas fa-check"></i></button>
          <button class="round-btn admin-decline" title="Decline"><i class="fas fa-times"></i></button>
        </div>
      `;

      // ✅ Approve Action
      div.querySelector('.admin-approve').addEventListener('click', async () => {
        if (p.type === 'order') {
          // 🟢 Order approval by owner (farmer)
          const confirm = await Swal.fire({
            title: 'Approve this order?',
            text: 'Approving will move it to Pending Deliveries for admin review.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Approve Order',
          });
          if (!confirm.isConfirmed) return;

          const delivery = {
            ...p,
            type: 'delivery',
            status: 'WaitingForAdminApproval',
            movedToDeliveryAt: Date.now(),
          };

          try {
            await database.ref('pendingDeliveries/' + id).set(delivery);
            await database.ref('pendingStock/' + id).remove();

            // Notify both buyer & owner about approval
            if (p.buyerId)
              await database.ref('notifications/' + p.buyerId).push({
                title: 'Order Approved by Seller',
                message: `${p.product} is now awaiting admin delivery approval.`,
                timestamp: Date.now(),
              });

            Swal.fire('Approved', 'Order moved to Pending Deliveries.', 'success');
          } catch (err) {
            Swal.fire('Error', err.message, 'error');
          }
        } else {
          // 🟢 Farmer Stock approval (admin only)
          const confirm = await Swal.fire({
            title: 'Approve this farmer stock?',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Approve Stock',
          });
          if (!confirm.isConfirmed) return;

const now = Date.now();
const expiryAt = now + 24 * 60 * 60 * 1000; // ⏰ 24 hours after approval

const approved = {
  ...p,
  status: 'approved',
  approvedAt: now,
  expiryAt: expiryAt,
};

try {
  await database.ref('stocks/' + id).set(approved);
  await database.ref('pendingStock/' + id).remove();

  Swal.fire(
    '✅ Approved!',
    `${p.product} is now visible in the Buy tab for 24 hours (until ${new Date(expiryAt).toLocaleString()}).`,
    'success'
  );
} catch (err) {
  console.error('Approval error:', err);
  Swal.fire('Error', err.message || 'Failed to approve item.', 'error');
}

        }
      });

      // ❌ Decline Action
      div.querySelector('.admin-decline').addEventListener('click', async () => {
        const { value: reason } = await Swal.fire({
          title: 'Reason for Decline',
          input: 'text',
          inputPlaceholder: 'Enter reason...',
          showCancelButton: true,
        });
        if (!reason) return;

        const declined = {
          ...p,
          status: 'Declined',
          reason,
          declinedAt: Date.now(),
        };

        const historyPath = p.type === 'order'
          ? 'adminHistory/'
          : 'farmerHistory/';

        try {
          await database.ref(historyPath + id).set(declined);
          await database.ref('pendingStock/' + id).remove();
          Swal.fire('Declined', 'Item moved to history.', 'info');
        } catch (err) {
          Swal.fire('Error', err.message, 'error');
        }
      });

      pendingList.appendChild(div);
    });

    if (adminPendingCountEl) adminPendingCountEl.textContent = count || 0;
    updateCartCounts();
  });
}

// ======================================================
// 🛒 LOAD BUY TAB ITEMS (fixed 24h timer + safe cleanup + no duplicate intervals)
// ======================================================
function loadBuyTabItems() {
  const list = document.getElementById('homeBuyList');
  const empty = document.getElementById('homeBuyEmpty');
  if (!list) return;

  list.innerHTML = `<div class="loading">Loading products...</div>`;

  const ref = database.ref('stocks');
  if (listeners['stocks']) listeners['stocks'].off();
  listeners['stocks'] = ref;

  // 🧹 Clear all previous countdowns
  if (window.activeBuyIntervals) {
    Object.values(window.activeBuyIntervals).forEach(clearInterval);
  }
  window.activeBuyIntervals = {};

  ref.on('value', snap => {
    list.innerHTML = '';
    const now = Date.now();
    const updates = {};

    if (!snap.exists()) {
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');

    snap.forEach(child => {
      const p = child.val();
      const id = child.key;
      if (!p || p.status !== 'approved') return;

      // ✅ Compute expiry time (24h)
      const expiryTime = p.expiryAt || (p.approvedAt ? p.approvedAt + 86400000 : 0);

      // 🧹 Remove expired items
      if (expiryTime && now >= expiryTime) {
        const expiredData = { ...p, status: 'expired', expiredAt: now };
        updates[`stocks/${id}`] = null;
        if (p.ownerId) updates[`history/${p.ownerId}/${id}`] = expiredData;
        return;
      }

      // =====================================================
      // 🧱 Build product card
      // =====================================================
      const div = document.createElement('div');
      div.className = 'product-card';
      div.innerHTML = `
        <div class="product-info">
          <h4>${p.product || 'Unnamed Item'}</h4>
          <p>Qty: ${p.qty || 0} KG | ₱${p.price || 0} per KG</p>
          <p><strong>Seller:</strong> ${p.ownerName || 'Unknown Seller'}</p>
          <p><strong>Location:</strong> ${p.ownerAddress || 'Unknown Address'}</p>
          <p class="stock-timer green">⏰ Calculating...</p>
        </div>
        <div class="card-actions">
          <button class="cta-button small"
            onclick="openCheckout('${id}', ${JSON.stringify(p).replace(/"/g, '&quot;')})"
            ${p.qty <= 0 ? 'disabled' : ''}>
            ${p.qty <= 0 ? 'Out of Stock' : 'Buy'}
          </button>
        </div>
      `;
      list.appendChild(div);

      // =====================================================
      // 🔄 Real-time countdown timer
      // =====================================================
      const timerEl = div.querySelector('.stock-timer');
      const updateTimer = () => {
        const remaining = expiryTime - Date.now();
        if (remaining <= 0) {
          clearInterval(window.activeBuyIntervals[id]);
          div.remove();
          const expiredNow = { ...p, status: 'expired', expiredAt: Date.now() };
          updates[`stocks/${id}`] = null;
          if (p.ownerId) updates[`history/${p.ownerId}/${id}`] = expiredNow;
          database.ref().update(updates);
          return;
        }

        const hrs = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        timerEl.textContent = `⏰ Expires in ${hrs}h ${mins}m ${secs}s`;
        timerEl.className = `stock-timer ${remaining < 2 * 3600000 ? 'red' : 'green'}`;
      };

      updateTimer();
      window.activeBuyIntervals[id] = setInterval(() => {
        if (!document.body.contains(div)) {
          clearInterval(window.activeBuyIntervals[id]);
        } else {
          updateTimer();
        }
      }, 1000);
    });

    // 🧹 Cleanup expired items once after iteration
    if (Object.keys(updates).length > 0) {
      database.ref().update(updates).then(() => {
        console.log(`🧹 Removed ${Object.keys(updates).length} expired items.`);
      });
    }
  });
}



// ======================================================
// 🔻 DEDUCT STOCK AFTER BUYER CHECKOUT
// ======================================================
async function deductStock(ownerId, stockId, qtyPurchased) {
  try {
    const stockRef = database.ref(`stocks/${stockId}`);
    const snap = await stockRef.once('value');
    if (!snap.exists()) return;

    const stock = snap.val();
    const remaining = (Number(stock.qty) || 0) - Number(qtyPurchased);

    if (remaining <= 0) {
      // Out of stock → remove it
      await stockRef.remove();
      pushToast(ownerId, `❌ ${stock.product || 'Item'} is now out of stock.`);
    } else {
      await stockRef.update({ qty: remaining });
      console.log(`✅ Deducted ${qtyPurchased} from ${stock.product}, remaining: ${remaining}`);
    }
  } catch (err) {
    console.error("Stock deduction error:", err);
  }
}

// =========================================================
// 🕒 AUTO-CLEAN EXPIRED PRODUCTS (24-hour expiry)
// Called automatically when Buy tab loads
// =========================================================
async function cleanupExpiredProducts() {
  try {
    const productsRef = database.ref("products");
    const snapshot = await productsRef.once("value");
    if (!snapshot.exists()) return;

    const now = Date.now();
    const updates = {};

    snapshot.forEach(ownerSnap => {
      const ownerId = ownerSnap.key;
      ownerSnap.forEach(productSnap => {
        const product = productSnap.val();
        const pid = productSnap.key;
        const expiresAt = product.expiresAt || product.ExpiryAt || product.expiryAt;

        if (expiresAt && now > expiresAt) {
          updates[`products/${ownerId}/${pid}`] = null;
          console.log(`🧹 Removed expired product: ${product.product || pid}`);
        }
      });
    });

    if (Object.keys(updates).length > 0) {
      await database.ref().update(updates);
      console.log(`✅ Expired product cleanup complete (${Object.keys(updates).length} removed).`);
    }
  } catch (err) {
    console.error("Expired product cleanup failed:", err);
  }
}

// ================= PENDING ORDERS (CUSTOMER / WHOLESALER) =================
function loadPendingOrders() {
  const ordersList = document.getElementById('ordersList');
  if (!ordersList) return;

  const ref = database.ref('orders');
  if (listeners['orders']) listeners['orders'].off();
  listeners['orders'] = ref;

  ref.on('value', snap => {
    ordersList.innerHTML = '';
    let count = 0;

    if (!snap.exists()) {
      ordersList.innerHTML = `<div class="empty-state">No pending orders for approval.</div>`;
    } else {
      snap.forEach(child => {
        const p = child.val();
        const id = child.key;
        count++;

        const div = document.createElement('div');
        div.className = 'orders-card';
        div.innerHTML = `
          <div>
            <p><strong>Transaction ID:</strong> ${p.transactionId || id}</p>
            <h4 style="text-transform:uppercase; font-weight:700;">${p.product || 'Unknown Product'}</h4>
            <p><strong>Qty:</strong> ${p.qty || 0} KG | <strong>₱${p.price || 0}.00</strong></p>
            <p><strong>Buyer:</strong> ${p.buyerName || 'Unknown'}</p>
            <p><strong>Seller:</strong> ${p.ownerName || 'Unknown'}</p>
            <p><strong>Status:</strong> ⏳ Pending (waiting for admin approval)</p>
          </div>
          <div class="card-actions">
            <button class="round-btn admin-approve" title="Approve"><i class="fas fa-check"></i></button>
            <button class="round-btn admin-decline" title="Decline"><i class="fas fa-times"></i></button>
          </div>
        `;

        // ✅ APPROVE — move to pendingDeliveries with full address info
        div.querySelector('.admin-approve').addEventListener('click', () => {
          Swal.fire({
            title: 'Approve this order for delivery?',
            text: 'This will make it visible for drivers to claim.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Approve'
          }).then(res => {
            if (res.isConfirmed) {
              // 🟢 Fetch seller (owner) and buyer addresses before moving
              const ownerRef = database.ref('users/' + p.ownerId);
              const buyerRef = database.ref('users/' + p.buyerId);

              Promise.all([ownerRef.once('value'), buyerRef.once('value')])
                .then(([ownerSnap, buyerSnap]) => {
                  const owner = ownerSnap.val() || {};
                  const buyer = buyerSnap.val() || {};

                  const deliveryData = {
                    ...p,
                    type: 'delivery',
                    status: 'WaitingForDriver',
                    ownerAddress: owner.address || 'Unknown',
                    destination: buyer.address || 'Unknown',
                    ownerPhone: owner.phone || '',
                    buyerPhone: buyer.phone || '',
                    movedToDeliveryAt: Date.now()
                  };

                  // ✅ Move to pendingDeliveries
                  return database.ref('pendingDeliveries/' + id).set(deliveryData);
                })
                .then(() => database.ref('orders/' + id).remove())
                .then(() => {
                  Swal.fire('Approved', 'Order moved to Pending Deliveries.', 'success');
                })
                .catch(err => Swal.fire('Error', err.message, 'error'));
            }
          });
        });

        // ❌ DECLINE — move to adminHistory
        div.querySelector('.admin-decline').addEventListener('click', () => {
          Swal.fire({
            title: 'Reason for Decline',
            input: 'text',
            inputPlaceholder: 'Enter reason...',
            showCancelButton: true
          }).then(res => {
            if (res.isConfirmed && res.value) {
              const declined = {
                ...p,
                status: 'DeclinedByAdmin',
                reason: res.value,
                declinedAt: Date.now()
              };

              database.ref('adminHistory/' + id).set(declined);
              database.ref('orders/' + id).remove();
              Swal.fire('Declined', 'Order moved to Admin History.', 'info');
            }
          });
        });

        ordersList.appendChild(div);
      });
    }

    updateCartCounts();
  });
}
// ======================================================
// 🧾 ADMIN: LOAD PENDING DELIVERIES (NeedAdminApproval)
// ✅ Atomic cleanup of orders
// ✅ Instantly syncs to On-Process tab after approval
// ======================================================
function loadPendingDeliveries() {
  const container = document.getElementById('pendingDeliveriesList');
  if (!container) return;

  container.innerHTML = `<div class="loading">Loading pending deliveries...</div>`;

  const ref = database.ref('pendingDeliveries');
  ref.off();

  ref.on('value', snap => {
    container.innerHTML = '';
    if (!snap.exists()) {
      container.innerHTML = `<div class="empty-state">No pending deliveries for approval.</div>`;
      return;
    }

    let found = false;

    snap.forEach(child => {
      const d = child.val() || {};
      const id = child.key;

      if (d.status === 'NeedAdminApproval') {
        found = true;

        const card = document.createElement('div');
        card.className = 'delivery-card light-card';
        card.innerHTML = `
          <div>
            <h4 style="text-transform:uppercase; font-weight:700;">${d.product || 'Delivery Item'}</h4>
            <p><strong>FROM:</strong> ${d.ownerAddress || 'Unknown'}<br>
            <strong>TO:</strong> ${d.destination || 'Unknown'}</p>
            <p><strong>Quantity:</strong> ${d.qty || 0} / 50KG</p>
            <p><strong>Price:</strong> ₱${Number(d.price || 0).toLocaleString()}</p>
            <p><strong>Driver:</strong> ${d.driverName || 'N/A'}</p>
          </div>
          <div class="card-actions"></div>
        `;

        const actions = card.querySelector('.card-actions');

        // ✅ APPROVE BUTTON (Check Icon)
        const approveBtn = document.createElement('button');
        approveBtn.className = 'round-btn admin-approve';
        approveBtn.innerHTML = `<i class="fas fa-check"></i>`;
        approveBtn.title = 'Approve & Input Amount';

        approveBtn.onclick = async () => {
          try {
            const { value: inputAmount } = await Swal.fire({
              title: 'Approve Delivery?',
              text: `Enter delivery payment for "${d.product || 'Unknown Item'}":`,
              input: 'number',
              inputPlaceholder: 'Enter delivery payment (₱)',
              showCancelButton: true,
              confirmButtonText: 'Confirm Approval'
            });

            if (inputAmount === undefined) return;

            const deliveryPayment = Number(inputAmount);
            if (isNaN(deliveryPayment) || deliveryPayment <= 0) {
              Swal.fire('Invalid Amount', 'Please enter a valid positive number.', 'warning');
              return;
            }

            // 💰 Compute totals
            const basePrice = (Number(d.price) || 0) * (Number(d.qty) || 1);
            const deliveryFee = Number(d.deliveryFee) || 0;
            const totalPayment = basePrice + deliveryFee + deliveryPayment;
            const timeNow = Date.now();

            // 🧾 Approved record
            const approved = {
              ...d,
              status: 'ItemOutForDelivery',
              approvedAt: timeNow,
              deliveryPayment,
              totalPayment,
              approvedBy: auth.currentUser?.uid || 'admin'
            };

            // ✅ Atomic multi-path updates
            const updates = {};
            updates[`onProcess/${id}`] = approved;
            updates[`pendingDeliveries/${id}`] = null;
            updates[`orders/${id}`] = null;

            if (d.buyerId)
              updates[`orders/${d.buyerId}/${id}`] = { ...approved, viewType: 'buyer' };
            if (d.ownerId)
              updates[`orders/${d.ownerId}/${id}`] = { ...approved, viewType: 'owner' };
            if (d.driverId) {
              updates[`orders/${d.driverId}/${id}`] = null;
              updates[`deliveries/${d.driverId}/${id}`] = { ...approved, viewType: 'driver' };
            }

            await database.ref().update(updates);

            // 🕓 Log Activity
            await database.ref('adminActivity').push({
              type: 'deliveryApproval',
              message: `✅ Approved ${d.product || 'item'} by ${d.driverName || 'driver'} (₱${deliveryPayment.toLocaleString()})`,
              timestamp: Date.now()
            });

            // 🔔 Timeline + Notifications
            const timelineMsg = `🚚 Admin approved delivery for ${d.product || 'item'} (₱${deliveryPayment.toLocaleString()} payment).`;
            if (typeof pushTimeline === 'function') {
              pushTimeline('admin', id, timelineMsg);
              if (d.buyerId) pushTimeline(d.buyerId, id, timelineMsg);
              if (d.ownerId) pushTimeline(d.ownerId, id, timelineMsg);
              if (d.driverId) pushTimeline(d.driverId, id, timelineMsg);
            }

            if (typeof pushToast === 'function') {
              pushToast(d.driverId, `📦 Delivery approved with ₱${deliveryPayment.toLocaleString()} payment.`);
              pushToast(d.ownerId, `📤 ${d.product || 'item'} is now out for delivery.`);
              pushToast(d.buyerId, `🚚 Your order ${d.product || ''} is now on its way!`);
            }

            Swal.fire(
              'Approved',
              `Moved to On-Process with ₱${deliveryPayment.toFixed(2)} delivery payment.`,
              'success'
            );

            // ✅ Instantly sync the new record into On-Process UI
            if (typeof loadOnProcess === 'function') loadOnProcess();

            // ✅ Remove card smoothly from Pending UI
            card.classList.add('fade-out');
            setTimeout(() => card.remove(), 400);

          } catch (err) {
            console.error('Approve delivery error:', err);
            Swal.fire('Error', err.message || 'An error occurred during approval.', 'error');
          }
        };

        // ❌ DECLINE BUTTON (X Icon)
        const declineBtn = document.createElement('button');
        declineBtn.className = 'round-btn admin-decline';
        declineBtn.innerHTML = `<i class="fas fa-times"></i>`;
        declineBtn.title = 'Decline Delivery';

        declineBtn.onclick = async () => {
          try {
            const { value: reason } = await Swal.fire({
              title: 'Decline this delivery?',
              text: 'Provide a reason for declining this delivery:',
              input: 'text',
              inputPlaceholder: 'Enter reason...',
              showCancelButton: true,
              confirmButtonText: 'Decline'
            });

            if (reason === undefined) return;
            const failReason = reason.trim() || 'No reason provided';

            const reset = {
              ...d,
              status: 'WaitingForDriver',
              declinedAt: Date.now(),
              declineReason: failReason
            };

            const updates = {};
            updates[`pendingDeliveries/${id}`] = reset;
            updates[`onProcess/${id}`] = null;
            updates[`orders/${id}`] = null;

            await database.ref().update(updates);

            await database.ref('adminActivity').push({
              type: 'deliveryDeclined',
              message: `❌ Declined ${d.product || 'item'} by ${d.driverName || 'driver'} (Reason: ${failReason})`,
              timestamp: Date.now()
            });

            Swal.fire('Declined', 'Delivery returned for reassignment.', 'info');

            // Smoothly remove card
            card.classList.add('fade-out');
            setTimeout(() => card.remove(), 400);

          } catch (err) {
            console.error('Decline delivery error:', err);
            Swal.fire('Error', err.message || 'An error occurred during decline.', 'error');
          }
        };

        actions.appendChild(approveBtn);
        actions.appendChild(declineBtn);
        container.appendChild(card);
      }
    });

    if (!found) {
      container.innerHTML = `<div class="empty-state">No pending deliveries for approval.</div>`;
    }
  });
}

// ✅ ADMIN: Load & Manage Wholesaler Applications
function loadApplications() {
  const list = document.getElementById('applicationsList'); // ensure this ID exists in HTML
  if (!list) return;
  list.innerHTML = '';

  const ref = database.ref('applications');
  if (listeners['applications']) listeners['applications'].off();
  listeners['applications'] = ref;

  ref.on('value', snap => {
    list.innerHTML = '';

    if (!snap.exists()) {
      list.innerHTML = `<div class="empty-state">No wholesaler applications found.</div>`;
      return;
    }

    let hasPending = false;

    snap.forEach(child => {
      const app = child.val();
      const id = child.key;

      // Show all applications (pending, approved, declined)
      const status = app.status || 'pending';
      if (status === 'pending') hasPending = true;

      const div = document.createElement('div');
      div.className = 'orders-card';
      div.innerHTML = `
        <div>
          <h4>${app.name || 'Unnamed User'}</h4>
          <p><strong>Requested Role:</strong> ${app.roleRequested || 'Wholesaler'}</p>
          <p><strong>Reason:</strong> ${app.reason || 'No reason provided.'}</p>
          <p><strong>Status:</strong> <span class="status ${status.toLowerCase()}">${status}</span></p>
          ${app.declineReason ? `<p><em>Decline reason:</em> ${app.declineReason}</p>` : ''}
        </div>
        <div class="card-actions">
          ${
            status === 'pending'
              ? `
                <button class="admin-approve" title="Approve"><i class="fas fa-check"></i></button>
                <button class="admin-decline" title="Decline"><i class="fas fa-times"></i></button>
              `
              : `<button class="round-btn" disabled>${status}</button>`
          }
        </div>
      `;

      // ✅ Approve
      const approveBtn = div.querySelector('.admin-approve');
      if (approveBtn) {
        approveBtn.addEventListener('click', async () => {
          const confirm = await Swal.fire({
            title: 'Approve Application?',
            text: `${app.name} will become a Wholesaler (Buy & Sell access).`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Approve',
          });
          if (!confirm.isConfirmed) return;

          try {
            const roleSnap = await database.ref('users/' + id + '/role').once('value');
            const currentRole = roleSnap.val();

            if (currentRole === 'admin') {
              Swal.fire('Access Denied', 'Admins cannot change their own role.', 'warning');
              return;
            }

            // ✅ Update both role and application
            await database.ref('users/' + id + '/role').set('wholesaler');
            await database.ref('applications/' + id).update({
              status: 'approved',
              approvedAt: Date.now()
            });

            // 🟢 Log history
            await database.ref(`transactions/${id}/history`).push({
              type: 'Application',
              name: app.name || 'User',
              result: 'Approved as Wholesaler',
              timestamp: Date.now(),
            });

            Swal.fire('Approved', `${app.name} is now a Wholesaler.`, 'success');
          } catch (err) {
            Swal.fire('Error', err.message, 'error');
          }
        });
      }

      // ❌ Decline
      const declineBtn = div.querySelector('.admin-decline');
      if (declineBtn) {
        declineBtn.addEventListener('click', async () => {
          const { value: declineReason } = await Swal.fire({
            title: 'Reason for Decline',
            input: 'text',
            inputPlaceholder: 'Enter decline reason...',
            showCancelButton: true,
          });

          if (!declineReason) return;

          try {
            await database.ref('applications/' + id).update({
              status: 'declined',
              declineReason,
              declinedAt: Date.now(),
            });

            // 🟢 Log history
            await database.ref(`transactions/${id}/history`).push({
              type: 'Application',
              name: app.name || 'User',
              result: 'Declined: ' + declineReason,
              timestamp: Date.now(),
            });

            Swal.fire('Declined', `${app.name}'s application was declined.`, 'info');
          } catch (err) {
            Swal.fire('Error', err.message, 'error');
          }
        });
      }

      list.appendChild(div);
    });

    if (!hasPending) {
      const noPending = document.createElement('div');
      noPending.className = 'empty-state';
      noPending.textContent = 'No pending applications right now.';
      list.appendChild(noPending);
    }
  });
}

// =========== FARMER ACTIONS (approve/decline) ===========
function farmerApproveRequest(id, p) {
  if (!id || !p) return;

  // --- DELIVERY ---
  if (p.type === 'delivery') {
    Swal.fire({
      title: 'Set Delivery Fee',
      input: 'number',
      inputLabel: 'Enter the delivery fee (₱)',
      inputPlaceholder: 'e.g. 50',
      inputAttributes: { min: 0 },
      showCancelButton: true,
      confirmButtonText: 'Approve',
      cancelButtonText: 'Cancel'
    }).then(result => {
      if (result.isConfirmed) {
        const deliveryFee = Number(result.value) || 0;
        const totalPrice = Number(p.price || 0) * Number(p.qty || 0);
        const totalPayment = totalPrice + deliveryFee;

        database.ref('pendingRequests/' + id).remove().catch(()=>{});

        const updated = { 
          ...p, 
          status: 'deliveryreqondelivery', 
          deliveryFee,
          totalPrice,
          totalPayment,
          approvedBy: auth.currentUser?.uid || 'farmer',
          approvedAt: Date.now()
        };

        if (p.userId) {
          database.ref('deliveries/' + p.userId + '/' + id).set(updated).catch(()=>{});
        }
        if (p.ownerId) {
          database.ref('deliveries/' + p.ownerId + '/' + id).set(updated).catch(()=>{});
        }

        database.ref('onProcess/' + id).set(updated).catch(()=>{});

        addActivity(`Farmer approved delivery: ${p.product || ''} total ₱${totalPayment}`);
        Swal.fire('Approved','Delivery approved with fee & total payment calculated','success');
      }
    });
    return;
  }

  // --- STOCK ---
  if (p.type === 'stock') {
    database.ref('pendingRequests/' + id).remove().catch(()=>{});
    const updated = { ...p, status: 'approved' };
    database.ref('stocks/' + id).set(updated).catch(()=>{});
    addActivity("Farmer approved stock: " + (p.product || 'item'));
    Swal.fire('Approved','Stock approved and added to marketplace','success');
    return;
  }

  // --- ORDER ---
  if (p.type === 'order') {
    database.ref('pendingRequests/' + id).remove().catch(()=>{});

    const totalPrice = Number(p.price || 0) * Number(p.qty || 0);

    const updated = { 
      ...p, 
      status: 'orderondelivery',
      totalPrice,
      approvedBy: auth.currentUser?.uid || 'farmer',
      approvedAt: Date.now()
    };

    if (p.ownerId) {
      database.ref('orders/' + p.ownerId + '/' + id).remove().catch(()=>{});
      database.ref('deliveries/' + p.ownerId + '/' + id).set(updated).catch(()=>{});
    }

    if (p.userId) {
      database.ref('orders/' + p.userId + '/' + id).remove().catch(()=>{});
      database.ref('deliveries/' + p.userId + '/' + id).set(updated).catch(()=>{});
    }

    database.ref('onProcess/' + id).set(updated).catch(()=>{});

    addActivity("Farmer approved order: " + (p.product || 'item') + " total ₱" + totalPrice);
    Swal.fire('Approved','Order approved and total price calculated','success');
    return;
  }
}


function farmerDeclineRequest(id, p) {
  if (!id || !p) return;

  Swal.fire({
    title: 'Decline Request',
    input: 'text',
    inputLabel: 'Reason for declining',
    inputPlaceholder: 'Enter reason...',
    inputAttributes: { maxlength: 200 },
    showCancelButton: true,
    confirmButtonText: 'Decline',
    cancelButtonText: 'Cancel',
    inputValidator: (value) => { if (!value) return 'You must provide a reason!'; }
  }).then(result => {
    if (result.isConfirmed) {
      const reason = result.value;
      database.ref('pendingRequests/' + id).remove().catch(()=>{});

      const declined = { 
        ...p, 
        status: 'declined', 
        declineReason: reason, 
        declinedAt: Date.now() 
      };

      if (p.type === 'delivery') {
        if (p.userId) {
          database.ref('deliveries/' + p.userId + '/' + id).remove().catch(()=>{});
          database.ref('history/' + p.userId + '/' + id).set(declined).catch(()=>{});
        }
        if (p.ownerId) {
          database.ref('deliveries/' + p.ownerId + '/' + id).remove().catch(()=>{});
          database.ref('history/' + p.ownerId + '/' + id).set(declined).catch(()=>{});
        }
        database.ref('adminHistory/' + id).set(declined).catch(()=>{});
        addActivity("Farmer declined delivery: " + (p.product || 'item') + " — " + reason);
      }

      else if (p.type === 'stock') {
        database.ref('declined/' + id).set(declined).catch(()=>{});
        addActivity("Farmer declined stock: " + (p.product || 'item') + " — " + reason);
      }

      else if (p.type === 'order') {
        if (p.userId) {
          database.ref('orders/' + p.userId + '/' + id).remove().catch(()=>{});
          database.ref('history/' + p.userId + '/' + id).set(declined).catch(()=>{});
        }
        if (p.ownerId) {
          database.ref('orders/' + p.ownerId + '/' + id).remove().catch(()=>{});
          database.ref('history/' + p.ownerId + '/' + id).set(declined).catch(()=>{});
        }
        database.ref('adminHistory/' + id).set(declined).catch(()=>{});
        addActivity("Farmer declined order: " + (p.product || 'item') + " — " + reason);
      }

      Swal.fire('Declined','Request declined with reason: ' + reason,'info');
    }
  });
}

// ======================================================
// ✅ ADMIN APPROVE STOCK (adds 24-hour expiry timer visible in Buy tab)
// ======================================================
function adminApproveStock(id, p) {
  // Remove from pending
  database.ref('pendingRequests/' + id).remove().catch(() => {});

  const now = Date.now();
  const expiryAt = now + 24 * 60 * 60 * 1000; // 24 hours from approval

  // Build updated stock data
  const updated = {
    ...p,
    status: 'approved',
    approvedAt: now,
    expiryAt: expiryAt,
    visible: true // ensures it appears in Buy tab immediately
  };

  // ✅ Ensure owner info exists
  if (!updated.ownerId && p.uid) updated.ownerId = p.uid;
  if (!updated.ownerName && p.name) updated.ownerName = p.name;

  // Save to stocks
  database.ref('stocks/' + id).set(updated)
    .then(() => {
      addActivity(`Admin approved stock: ${p.product || 'item'} (expires in 24h)`);

      // Optional: notify farmer
      if (p.ownerId)
        pushToast(p.ownerId, `✅ Your product "${p.product}" was approved and will be listed for 24 hours.`);

      Swal.fire(
        'Approved',
        'Stock is now live in marketplace (expires in 24 hours)',
        'success'
      );
    })
    .catch(err => {
      console.error('Approve stock error:', err);
      Swal.fire('Error', err.message || 'Failed to approve stock', 'error');
    });
}

// ======================================================
// ❌ ADMIN DECLINE STOCK
// ======================================================
function adminDeclineStock(id, p) {
  Swal.fire({
    title: 'Decline Reason',
    input: 'text',
    inputLabel: 'Why is this stock declined?',
    showCancelButton: true,
    confirmButtonText: 'Decline'
  }).then(result => {
    if (result.isConfirmed) {
      const reason = result.value || "No reason provided";
      database.ref('pendingRequests/' + id).remove();
      database.ref('declined/' + id).set({ ...p, declinedReason: reason });
      addActivity("Admin declined stock: " + (p.product || 'item') + " — " + reason);
      Swal.fire('Declined', 'Stock request declined', 'info');
    }
  });
}

// =========================================================
// 🕒 AUTO-EXPIRE APPROVED FARMER STOCKS AFTER 24 HOURS
// =========================================================
function checkExpiredStocks() {
  const now = Date.now();
  const ref = database.ref('stocks');
  ref.once('value', snap => {
    if (!snap.exists()) return;

    snap.forEach(child => {
      const stock = child.val();
      const id = child.key;

      // Check if stock is approved and expired
      if (stock.status === 'approved' && stock.expiryAt && now >= stock.expiryAt) {
        const updates = {};

        // Remove from active stocks
        updates[`stocks/${id}`] = null;

        // Move to farmer's history only
        if (stock.ownerId) {
          updates[`history/${stock.ownerId}/${id}`] = {
            ...stock,
            status: 'expired',
            expiredAt: now
          };
        }

        // Apply database update
        database.ref().update(updates).then(() => {
          console.log(`Stock ${id} expired and moved to history.`);
          pushToast(stock.ownerId, `⏰ Your product "${stock.product}" has expired and was moved to history.`);
        }).catch(err => console.error('Expiry update error:', err));
      }
    });
  });
}

// 🔁 Run the check every minute (60,000 ms)
setInterval(checkExpiredStocks, 60 * 1000);

// 🕒 Run once immediately when admin logs in (optional)
if (typeof currentUserRole !== 'undefined' && currentUserRole === 'admin') {
  checkExpiredStocks();
}

// =========================================================
// 🚚 ADMIN APPROVES ORDER → Moves to Pending Deliveries
// =========================================================
function adminApproveOrder(id, orderData) {
  // Confirm approval
  Swal.fire({
    title: 'Approve this order for delivery?',
    text: 'This will move the order to the delivery queue for drivers.',
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'Approve'
  }).then(res => {
    if (!res.isConfirmed) return;

    // Create a delivery object for drivers
    const delivery = {
      ...orderData,
      type: 'delivery',
      status: 'WaitingForDriver',
      movedToDeliveryAt: Date.now()
    };

    // ✅ Move to pendingDeliveries
    database.ref('pendingDeliveries/' + id).set(delivery)
      .then(() => {
        // 🧹 Remove from pendingRequests
        return database.ref('pendingRequests/' + id).remove();
      })
      .then(() => {
        Swal.fire('Approved', 'Order moved to Pending Deliveries.', 'success');
      })
      .catch(err => {
        Swal.fire('Error', err.message, 'error');
      });
  });
}

// ================= ON PROCESS (shows driver info + adds timeline for ItemOutForDelivery) =================
function loadOnProcess() {
  if (!onProcessList) return;
  onProcessList.innerHTML = '';

  const ref = database.ref('onProcess');
  if (listeners['onProcess']) try { listeners['onProcess'].off(); } catch (e) {}
  listeners['onProcess'] = ref;

  ref.on('value', async (snap) => {
    try {
      onProcessList.innerHTML = '';
      let count = 0;

      if (!snap.exists()) {
        onProcessList.innerHTML = `<div class="empty-state">No items on process.</div>`;
        if (adminOnProcessCountEl) adminOnProcessCountEl.textContent = '0 (empty)';
        updateCartCounts();
        return;
      }

      const data = snap.val();

      for (const id of Object.keys(data)) {
        const p = data[id];
        const validStatuses = [
          'NeedAdminApproval',
          'DeliveredPendingAdmin',
          'OnDelivery',
          'ItemOutForDelivery',
          'Processing',
          'FailedDelivery'
        ];
        if (!validStatuses.includes(p.status)) continue;

        // 🟢 Sync deliveries when out for delivery
        if (p.status === 'ItemOutForDelivery') {
          const updates = {};
          const time = Date.now();
          if (p.buyerId)
            updates[`deliveries/${p.buyerId}/${id}`] = { ...p, viewType: 'buyer', movedToDeliveryAt: time };
          if (p.ownerId)
            updates[`deliveries/${p.ownerId}/${id}`] = { ...p, viewType: 'owner', movedToDeliveryAt: time };
          if (p.driverId)
            updates[`deliveries/${p.driverId}/${id}`] = { ...p, viewType: 'driver', movedToDeliveryAt: time };

          if (Object.keys(updates).length) {
            try {
              await database.ref().update(updates);
              const timelineMsg = `🚚 Item "${p.product || 'item'}" is now out for delivery.`;
              if (typeof pushTimeline === 'function') {
                pushTimeline('admin', id, timelineMsg);
                if (p.buyerId) pushTimeline(p.buyerId, id, timelineMsg);
                if (p.ownerId) pushTimeline(p.ownerId, id, timelineMsg);
                if (p.driverId) pushTimeline(p.driverId, id, timelineMsg);
              }

              if (typeof pushToast === 'function') {
                pushToast(p.driverId, `🚚 You have a new delivery: ${p.product || 'item'}.`);
                pushToast(p.buyerId, `📦 Your order ${p.product || 'item'} is out for delivery.`);
                pushToast(p.ownerId, `📤 Your item ${p.product || 'item'} is being delivered.`);
              }
            } catch (e) {
              console.warn('deliveries sync failed', e);
            }
          }
        }

        // 🧱 Build Card
        count++;
        const div = document.createElement('div');
        div.className = 'orders-card';

        const price = Number(p.price) || 0;
        const qty = Number(p.qty) || 0;
        const deliveryFee = Number(p.deliveryFee) || 0;
        const deliveryPayment = Number(p.deliveryPayment) || 0;
        const totalPayment = (price * qty) + deliveryFee + deliveryPayment;

        div.innerHTML = `
          <div>
            <p><strong>Transaction ID:</strong> ${p.transactionId || id}</p>
            <h4 style="font-weight:bold;text-transform:uppercase;">${p.product || 'Item'}</h4>
            <p><strong>Quantity:</strong> ${qty} ${p.price ? `| ₱${p.price.toLocaleString()} each` : ''}</p>

            <hr>
            <h4>🛍️ Buyer Information</h4>
            <p><strong>Name:</strong> ${p.buyerName || 'N/A'}</p>
            <p><strong>Address:</strong> ${p.buyerAddress || p.destination || 'Unknown'}</p>
            <p><strong>Phone:</strong> ${p.buyerPhone || 'N/A'}</p>

            <hr>
            <h4>🏪 Seller Information</h4>
            <p><strong>Name:</strong> ${p.ownerName || 'N/A'}</p>
            <p><strong>Address:</strong> ${p.ownerAddress || 'Unknown'}</p>
            <p><strong>Phone:</strong> ${p.ownerPhone || 'N/A'}</p>

            <hr>
            <h4>🚚 Driver Information</h4>
            <p><strong>Name:</strong> ${p.driverName || 'Not yet assigned'}</p>
            <p><strong>Phone:</strong> ${p.driverPhone || 'N/A'}</p>
            ${p.driverVehicle ? `<p><strong>Vehicle:</strong> ${p.driverVehicle}</p>` : ''}
            ${p.driverPlate ? `<p><strong>Plate No.:</strong> ${p.driverPlate}</p>` : ''}

            <hr>
            <h4>💵 Payment Details</h4>
            <p><strong>Item Cost:</strong> ₱${(p.price * qty).toLocaleString()}</p>
            <p><strong>Delivery Payment (Admin Input):</strong> ₱${deliveryPayment.toLocaleString()}</p>
            <h3 style="margin-top:10px;color:green;">💰 Total: ₱${totalPayment.toLocaleString()}</h3>

            <hr>
            <p><strong>Status:</strong> ${p.status}</p>
          </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'card-actions';

        // ✅ ADMIN - Confirm Delivered
        if (currentUserRole === 'admin' && p.status === 'DeliveredPendingAdmin') {
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'round-btn approve';
          confirmBtn.innerHTML = '<i class="fas fa-box"></i>';
          confirmBtn.title = 'Confirm Delivered';
          confirmBtn.onclick = () => adminConfirmDelivered(id, p);
          actions.appendChild(confirmBtn);
        }

        // 🔴 ADMIN - Review Failed
        if (currentUserRole === 'admin' && p.status === 'FailedDelivery') {
          const failedBtn = document.createElement('button');
          failedBtn.className = 'round-btn admin-fail';
          failedBtn.innerHTML = '<i class="fas fa-times-circle"></i>';
          failedBtn.title = 'Review Failed Delivery';
          failedBtn.onclick = () => {
            Swal.fire({
              title: 'Confirm mark as Failed?',
              text: 'This will move the record to Admin History.',
              icon: 'warning',
              showCancelButton: true,
              confirmButtonText: 'Confirm'
            }).then(res => {
              if (!res.isConfirmed) return;
              const updated = { ...p, status: 'FailedByAdmin', reviewedAt: Date.now() };
              const updates = {};
              updates[`adminHistory/${id}`] = updated;
              updates[`onProcess/${id}`] = null;
              if (p.driverId) updates[`deliveries/${p.driverId}/${id}`] = updated;
              if (p.buyerId) updates[`deliveries/${p.buyerId}/${id}`] = updated;
              if (p.ownerId) updates[`deliveries/${p.ownerId}/${id}`] = updated;
              database.ref().update(updates);
              pushTimeline('admin', id, 'Admin confirmed delivery failure.');
              Swal.fire('Marked', 'Moved to Admin History as failed.', 'info');
            });
          };
          actions.appendChild(failedBtn);
        }

        // 🟡 ADMIN - Approve with Delivery Payment Input
        if (currentUserRole === 'admin' && p.status === 'NeedAdminApproval') {
          const approveBtn = document.createElement('button');
          approveBtn.className = 'round-btn admin-approve';
          approveBtn.innerHTML = `<i class="fas fa-check"></i>`;
          approveBtn.title = 'Approve Delivery';

          approveBtn.onclick = async () => {
            try {
              const baseTotal = (Number(p.price) || 0) * (Number(p.qty) || 0) + (Number(p.deliveryFee) || 0);

              const { value: deliveryPayment } = await Swal.fire({
                title: 'Approve Delivery Request',
                input: 'number',
                inputPlaceholder: 'Enter Delivery Payment (₱)',
                inputAttributes: { min: 1, step: '0.01' },
                showCancelButton: true,
                confirmButtonText: 'Approve'
              });

              if (deliveryPayment === undefined) return;

              const time = Date.now();
              const totalPayment = baseTotal + Number(deliveryPayment);

              const approved = {
                ...p,
                status: 'ItemOutForDelivery',
                deliveryPayment: Number(deliveryPayment),
                totalPayment,
                approvedAt: time,
                approvedBy: auth.currentUser?.uid || 'admin'
              };

              const updates = {};
              updates[`onProcess/${id}`] = approved;

              if (p.buyerId)
                updates[`deliveries/${p.buyerId}/${id}`] = { ...approved, viewType: 'buyer', movedToDeliveryAt: time };
              if (p.ownerId)
                updates[`deliveries/${p.ownerId}/${id}`] = { ...approved, viewType: 'owner', movedToDeliveryAt: time };
              if (p.driverId)
                updates[`deliveries/${p.driverId}/${id}`] = { ...approved, viewType: 'driver', movedToDeliveryAt: time };

              await database.ref().update(updates);

              const timelineMsg = `🚚 Admin approved delivery for ${p.product || 'item'} with ₱${Number(deliveryPayment).toLocaleString()} delivery payment.`;
              if (typeof pushTimeline === 'function') {
                pushTimeline('admin', id, timelineMsg);
                if (p.buyerId) pushTimeline(p.buyerId, id, timelineMsg);
                if (p.ownerId) pushTimeline(p.ownerId, id, timelineMsg);
                if (p.driverId) pushTimeline(p.driverId, id, timelineMsg);
              }

              if (typeof pushToast === 'function') {
                pushToast(p.driverId, `📦 New delivery approved with ₱${Number(deliveryPayment).toLocaleString()} payment.`);
                pushToast(p.ownerId, `📤 Your item ${p.product || ''} is now out for delivery.`);
                pushToast(p.buyerId, `📦 Your order ${p.product || ''} is now on its way!`);
              }

              Swal.fire('Approved!', `Delivery approved with ₱${Number(deliveryPayment).toLocaleString()} payment.`, 'success');
              if (typeof loadOnProcess === 'function') loadOnProcess();

            } catch (err) {
              console.error('Approval error:', err);
              Swal.fire('Error', err.message || 'An error occurred while approving delivery.', 'error');
            }
          };

          const declineBtn = document.createElement('button');
          declineBtn.className = 'round-btn admin-decline';
          declineBtn.innerHTML = `<i class="fas fa-times"></i>`;
          declineBtn.title = 'Decline Delivery';
          declineBtn.onclick = async () => {
            const { value: reason } = await Swal.fire({
              title: 'Reason for Decline',
              input: 'text',
              inputPlaceholder: 'Enter reason...',
              showCancelButton: true,
              confirmButtonText: 'Submit'
            });
            if (!reason) return;
            const declined = { ...p, status: 'DeclinedByAdmin', reason, declinedAt: Date.now() };
            const updates = {};
            updates[`adminHistory/${id}`] = declined;
            updates[`onProcess/${id}`] = null;
            await database.ref().update(updates);
            Swal.fire('Declined', 'Delivery moved to Admin History.', 'info');
          };

          actions.appendChild(approveBtn);
          actions.appendChild(declineBtn);
        }

        // 🚚 DRIVER ACTIONS (✅ simplified)
        if (
          ['driver', 'driverin', 'driverout'].includes((currentUserRole || '').toLowerCase()) &&
          ['OnDelivery', 'ItemOutForDelivery'].includes(p.status) &&
          p.driverId === auth.currentUser?.uid
        ) {
          const successBtn = document.createElement('button');
          successBtn.className = 'round-btn admin-success';
          successBtn.textContent = 'Success';
          successBtn.onclick = async () => {
            try {
              await finalizeDelivery(id, p, 'Delivered');
              Swal.fire('Delivered!', 'Delivery marked as successful.', 'success');
            } catch (err) {
              console.error('Driver success error:', err);
              Swal.fire('Error', err.message || 'Something went wrong confirming delivery.', 'error');
            }
          };

          const failBtn = document.createElement('button');
          failBtn.className = 'round-btn admin-fail';
          failBtn.textContent = 'Failed';
          failBtn.onclick = async () => {
            try {
              const { value: failReason } = await Swal.fire({
                title: 'Mark Delivery as Failed?',
                input: 'text',
                inputPlaceholder: 'Enter reason...',
                showCancelButton: true,
                confirmButtonText: 'Confirm'
              });
              if (failReason === undefined) return;
              await finalizeDelivery(id, p, 'Failed', failReason);
            } catch (err) {
              console.error('Driver fail error:', err);
              Swal.fire('Error', err.message || 'Something went wrong marking failure.', 'error');
            }
          };

          actions.appendChild(successBtn);
          actions.appendChild(failBtn);
        }

        div.appendChild(actions);
        onProcessList.appendChild(div);
      }

      if (adminOnProcessCountEl) adminOnProcessCountEl.textContent = count > 0 ? count : '0 (empty)';
      updateCartCounts();
    } catch (err) {
      console.error('loadOnProcess error:', err);
      onProcessList.innerHTML = `<div class="empty-state">Error loading items.</div>`;
    }
  });
}
// =========================================================
// 🚚 FINALIZE DELIVERY (Driver marks success or failure)
// ✅ Single-step confirmation (no double dialogs)
// ✅ Auto-sync with adminConfirmDelivered flow
// ✅ Cleans up stale deliveries & avoids ghost records
// ✅ No more "Cannot set properties of undefined (setting 'opacity')" errors
// =========================================================
async function finalizeDelivery(transactionId, data, result, btnElement = null) {
  const isDelivered = result === 'Delivered';

  // 🧩 Safe helper for updating button state
  const safeButton = (state = {}) => {
    if (!btnElement || typeof btnElement !== 'object') return;
    try {
      if ('disabled' in state) btnElement.disabled = state.disabled;
      if ('text' in state && btnElement.innerText !== undefined)
        btnElement.innerText = state.text;
      if ('opacity' in state && btnElement.style)
        btnElement.style.opacity = state.opacity;
    } catch (e) {
      console.warn('⚠️ Button update skipped:', e);
    }
  };

  try {
    // 🔒 Prevent double clicks
    safeButton({ disabled: true, text: isDelivered ? 'Processing…' : 'Updating…', opacity: '0.7' });

    let failReason = '';
    let paymentReceived = 0;

    // 🔴 FAILED DELIVERY
    if (!isDelivered) {
      const { value } = await Swal.fire({
        title: 'Mark as Failed?',
        input: 'text',
        inputPlaceholder: 'Enter failure reason...',
        showCancelButton: true,
        confirmButtonText: 'Confirm',
      });

      if (value === undefined) return safeButton({ disabled: false, text: 'Mark as Failed', opacity: '1' });
      failReason = value.trim() || 'No reason provided';
    }

    // 🟢 SUCCESSFUL DELIVERY
    else {
      const { value: payment } = await Swal.fire({
        title: 'Enter Payment Received (₱)',
        input: 'number',
        inputPlaceholder: 'e.g. 500',
        showCancelButton: true,
        confirmButtonText: 'Mark as Delivered',
        inputAttributes: { min: 0, step: 'any' },
      });

      if (payment === undefined) return safeButton({ disabled: false, text: 'Delivered', opacity: '1' });
      paymentReceived = Number(payment);
      if (isNaN(paymentReceived)) paymentReceived = 0;
    }

    // 🧮 Compute totals safely
    const price = Number(data.price) || 0;
    const qty = Number(data.qty) || 0;
    const deliveryFee = Number(data.deliveryFee) || 0;
    const deliveryPayment = Number(data.deliveryPayment) || 0;
    const totalPayment = (price * qty) + deliveryFee + deliveryPayment;

    const uid = auth.currentUser?.uid || data.driverId;
    const time = Date.now();

    // ✅ Updated record
    const record = {
      ...data,
      status: isDelivered ? 'DeliveredPendingAdmin' : 'FailedDelivery',
      finalizedAt: time,
      finalizedBy: uid,
      failReason,
      paymentReceived,
      deliveryPayment,
      totalPayment,
      driverId: data.driverId || uid,
      driverName: data.driverName || data.riderName || 'Assigned Driver',
    };

    // =====================================================
    // 🗂️ DATABASE UPDATES
    // =====================================================
    const updates = {};
    updates[`onProcess/${transactionId}`] = record;
    if (data.buyerId) updates[`deliveries/${data.buyerId}/${transactionId}`] = record;
    if (data.ownerId) updates[`deliveries/${data.ownerId}/${transactionId}`] = record;
    if (data.driverId) updates[`deliveries/${data.driverId}/${transactionId}`] = record;

    await database.ref().update(updates);

    // =====================================================
    // 🕓 TIMELINE EVENT
    // =====================================================
    const timeLabel = new Date(time).toLocaleString();
    const timelineMsg = isDelivered
      ? `📦 Driver marked "${data.product || 'item'}" as delivered at ${timeLabel}. Payment received: ₱${paymentReceived}. Awaiting admin confirmation.`
      : `❌ Delivery failed at ${timeLabel}. Reason: ${failReason}`;

    if (typeof pushTimeline === 'function') {
      pushTimeline('driver', transactionId, timelineMsg);
      if (data.buyerId) pushTimeline(data.buyerId, transactionId, timelineMsg);
      if (data.ownerId) pushTimeline(data.ownerId, transactionId, timelineMsg);
      if (data.driverId) pushTimeline(data.driverId, transactionId, timelineMsg);
      pushTimeline('admin', transactionId, timelineMsg);
    }

    // =====================================================
    // 🔔 NOTIFICATIONS
    // =====================================================
    if (typeof pushToast === 'function') {
      if (isDelivered) {
        pushToast('admin', `✅ ${record.driverName} marked ${data.product || 'item'} as delivered.`);
        pushToast(data.buyerId, `🎉 Your order "${data.product || ''}" has been delivered! Awaiting admin confirmation.`);
        pushToast(data.ownerId, `📤 Your item "${data.product || ''}" was delivered successfully.`);
      } else {
        pushToast('admin', `⚠️ Driver reported a failed delivery for ${transactionId}.`);
        pushToast(data.ownerId, `⚠️ Delivery failed for ${data.product || ''}: ${failReason}`);
      }
    }

    // =====================================================
    // 🧹 AUTO-CLEAN STALE DELIVERIES
    // =====================================================
    const cleanupDeliveries = async () => {
      const userIds = [data.buyerId, data.ownerId, data.driverId];
      for (const uid of userIds) {
        if (!uid) continue;
        const ref = database.ref(`deliveries/${uid}`);
        const snap = await ref.once('value');
        if (!snap.exists()) continue;
        const val = snap.val();
        for (const [tid, entry] of Object.entries(val)) {
          if (['Completed', 'FailedDelivery'].includes(entry.status)) {
            await database.ref(`deliveries/${uid}/${tid}`).remove();
            console.log(`🧹 Cleaned delivery ${tid} for ${uid}`);
          }
        }
      }
    };
    await cleanupDeliveries();

    // inside finalizeDelivery after cleanup (add these lines)
await removeOrderEntriesForTransaction(transactionId, data);
await updateDeliveriesBadgeForUser(auth.currentUser?.uid);
if (typeof loadHistory === 'function') loadHistory();
if (typeof loadDeliveries === 'function') loadDeliveries();

    // =====================================================
    // ✅ UI FEEDBACK
    // =====================================================
    await Swal.fire(
      isDelivered ? 'Delivered!' : 'Failed',
      isDelivered
        ? 'Marked as delivered. Waiting for admin confirmation.'
        : 'Marked as failed.',
      isDelivered ? 'success' : 'info'
    );

    if (typeof loadDeliveries === 'function') loadDeliveries();
    if (typeof loadOnProcess === 'function') loadOnProcess();

  } catch (err) {
    console.error('❌ Finalize delivery error:', err);
    Swal.fire('Error', err.message || 'An error occurred while finalizing delivery.', 'error');
  } finally {
    // 🔓 Restore button safely
    safeButton({ disabled: false, text: isDelivered ? 'Delivered' : 'Mark as Failed', opacity: '1' });
  }
}
// =========================================================
// 🟢 ADMIN CONFIRM DELIVERED (FULL CLEANUP + HISTORY MOVE)
// ✅ Moves item to buyer/seller/driver histories
// ✅ Updates all related order statuses
// ✅ Cleans up all Deliveries (buyer/seller/driver)
// ✅ Removes pending + onProcess + empty branches
// ✅ Keeps timeline + notifications synced
// =========================================================
async function adminConfirmDelivered(transactionId, data) {
  try {
    const confirm = await Swal.fire({
      title: 'Confirm Delivered?',
      text: `Confirm delivery for "${data.product || 'Unknown Item'}"?`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Yes, Confirm'
    });

    if (!confirm.isConfirmed) return;

    const time = Date.now();
    const adminId = auth.currentUser?.uid || 'admin';

    // 🧮 Compute totals safely
    const price = Number(data.price) || 0;
    const qty = Number(data.qty) || 0;
    const deliveryFee = Number(data.deliveryFee) || 0;
    const deliveryPayment = Number(data.deliveryPayment) || 0;
    const totalPayment = (price * qty) + deliveryFee + deliveryPayment;

    // ✅ Final data record
    const finalized = {
      ...data,
      status: 'Completed',
      completedAt: time,
      confirmedBy: adminId,
      confirmationNote: 'Delivery confirmed by admin.',
      totalPayment,
      deliveryPayment,
      driverName: data.driverName || 'Unassigned Driver',
    };

    // =====================================================
    // 🗂️ DATABASE UPDATES
    // =====================================================
    const updates = {};

    // 🧾 Admin Transactions + History
    updates[`transactions/${transactionId}`] = finalized;
    updates[`adminHistory/${transactionId}`] = finalized;

    // 🧾 Buyer/Seller/Driver Histories
    if (data.buyerId) updates[`history/${data.buyerId}/${transactionId}`] = finalized;
    if (data.ownerId) updates[`history/${data.ownerId}/${transactionId}`] = finalized;
    if (data.driverId) updates[`history/${data.driverId}/${transactionId}`] = finalized;

    // 🧾 Update active Orders (Buyer/Seller)
    if (data.buyerId) {
      updates[`orders/${data.buyerId}/${transactionId}/status`] = 'Delivered';
      updates[`orders/${data.buyerId}/${transactionId}/deliveredAt`] = time;
    }
    if (data.ownerId) {
      updates[`orders/${data.ownerId}/${transactionId}/status`] = 'Delivered';
      updates[`orders/${data.ownerId}/${transactionId}/deliveredAt`] = time;
    }

    // 🚮 Cleanup Deliveries for Buyer/Seller/Driver
    if (data.buyerId) updates[`deliveries/${data.buyerId}/${transactionId}`] = null;
    if (data.ownerId) updates[`deliveries/${data.ownerId}/${transactionId}`] = null;
    if (data.driverId) updates[`deliveries/${data.driverId}/${transactionId}`] = null;

    // 🚮 Remove from Pending and OnProcess nodes
    updates[`onProcess/${transactionId}`] = null;
    updates[`pendingDeliveries/${transactionId}`] = null;
    updates[`pendingOrders/${transactionId}`] = null;

    // 🧾 Move to Delivery History (Driver)
    if (data.driverId) {
      updates[`deliveryHistory/${data.driverId}/${transactionId}`] = finalized;
    }

    // ✅ Atomic update
    await database.ref().update(updates);
// right after await database.ref().update(updates);
await removeOrderEntriesForTransaction(transactionId, data);

// update badges for buyer, owner, and driver (if present)
await updateDeliveriesBadgeForUser(data.driverId);
await updateDeliveriesBadgeForUser(data.buyerId);
await updateDeliveriesBadgeForUser(data.ownerId);

// refresh UIs
if (typeof loadHistory === 'function') loadHistory();
if (typeof loadDeliveries === 'function') loadDeliveries();
if (typeof loadOnProcess === 'function') loadOnProcess();

    // =====================================================
    // 🧹 CLEAN EMPTY DELIVERY BRANCHES (SAFE)
    // =====================================================
    const cleanEmptyDeliveries = async (uid) => {
      if (!uid) return;
      const ref = database.ref(`deliveries/${uid}`);
      const snap = await ref.once('value');
      if (!snap.exists()) return;
      const val = snap.val();
      const remaining = Object.values(val).filter(v => v !== null && typeof v === 'object');
      if (remaining.length === 0) {
        await ref.remove();
        console.log(`🧹 Removed empty deliveries branch for: ${uid}`);
      }
    };

    await Promise.all([
      cleanEmptyDeliveries(data.buyerId),
      cleanEmptyDeliveries(data.ownerId),
      cleanEmptyDeliveries(data.driverId),
    ]);

    // =====================================================
    // 🕓 TIMELINE EVENT
    // =====================================================
    const timeLabel = new Date(time).toLocaleString();
    const timelineMsg = `🏁 Admin confirmed delivery of "${data.product || 'item'}" at ${timeLabel}.`;

    if (typeof pushTimeline === 'function') {
      pushTimeline('admin', transactionId, timelineMsg);
      if (data.buyerId) pushTimeline(data.buyerId, transactionId, timelineMsg);
      if (data.ownerId) pushTimeline(data.ownerId, transactionId, timelineMsg);
      if (data.driverId) pushTimeline(data.driverId, transactionId, timelineMsg);
    }

    // =====================================================
    // 🔔 NOTIFICATIONS
    // =====================================================
    if (typeof pushToast === 'function') {
      pushToast(data.driverId, `✅ Delivery for ${data.product || ''} confirmed by admin.`);
      pushToast(data.ownerId, `📦 Your item ${data.product || ''} was successfully delivered and confirmed.`);
      pushToast(data.buyerId, `🎉 Your order ${data.product || ''} is now officially completed!`);
    }

    // =====================================================
    // 📰 ADMIN ACTIVITY LOG
    // =====================================================
    await database.ref('adminActivity').push({
      type: 'deliveryConfirmed',
      message: `🏁 Admin confirmed delivery of "${data.product || 'item'}" for ${data.buyerName || 'buyer'} by ${finalized.driverName}.`,
      transactionId,
      product: data.product || 'Unknown Item',
      buyer: data.buyerName || 'Unknown Buyer',
      seller: data.ownerName || 'Unknown Seller',
      driver: finalized.driverName,
      timestamp: time,
      adminId
    });

    // =====================================================
    // ✅ UI REFRESH
    // =====================================================
    Swal.fire('Confirmed!', 'Delivery confirmed and moved to all histories.', 'success');

    if (typeof loadAdminHistoryList === 'function') loadAdminHistoryList();
    if (typeof loadDeliveries === 'function') loadDeliveries();
    if (typeof loadOnProcess === 'function') loadOnProcess();
    if (typeof loadHistory === 'function') loadHistory();
    if (typeof loadActivityFeed === 'function') loadActivityFeed(true);

  } catch (err) {
    console.error('Admin confirm delivery error:', err);
    Swal.fire('Error', err.message || 'An error occurred while confirming delivery.', 'error');
  }
}

// =========================================================
// 📰 ADMIN ACTIVITY FEED (Enhanced Version)
// ✅ Shows last 3 days
// ✅ Auto-prunes logs >7 days
// ✅ Infinite scroll + real-time
// ✅ Grouped by day + "x minutes ago"
// =========================================================

let activityListening = false;
let allActivityItems = [];
let loadedCount = 0;
const LOAD_BATCH_SIZE = 15;
const dateGroups = {};

async function loadActivityFeed() {
  const list = document.getElementById("recentActivityList");
  if (!list) return;
  list.innerHTML = `<div class="loading">Loading recent activities...</div>`;

  const now = Date.now();
  const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

  // 🧹 1️⃣ Auto-Prune older than 7 days
  try {
    const oldSnap = await database
      .ref("adminActivity")
      .orderByChild("timestamp")
      .endAt(sevenDaysAgo)
      .once("value");

    if (oldSnap.exists()) {
      const cleanup = {};
      oldSnap.forEach((child) => (cleanup[`adminActivity/${child.key}`] = null));
      await database.ref().update(cleanup);
      console.log(`🧹 Pruned ${Object.keys(cleanup).length} old logs (>7d).`);
    }
  } catch (e) {
    console.warn("⚠️ Auto-prune failed:", e.message);
  }

  // 🧾 2️⃣ Fetch recent (3 days) logs
  const ref = database
    .ref("adminActivity")
    .orderByChild("timestamp")
    .startAt(threeDaysAgo);
  const snap = await ref.once("value");

  list.innerHTML = "";
  allActivityItems = [];
  if (!snap.exists()) {
    list.innerHTML = `<div class="empty-state">No recent activities.</div>`;
    return;
  }

  snap.forEach((child) =>
    allActivityItems.unshift({ id: child.key, ...child.val() })
  );
  loadedCount = 0;
  renderNextBatch(list);

  // 🔄 3️⃣ Live listener for new activity
  if (!activityListening) {
    const liveRef = database
      .ref("adminActivity")
      .orderByChild("timestamp")
      .startAt(threeDaysAgo);
    liveRef.on("child_added", (snap) => {
      const item = snap.val();
      if (!item || item.timestamp < threeDaysAgo) return;
      prependActivity(list, { id: snap.key, ...item });
    });
    activityListening = true;
  }

  // ♾️ 4️⃣ Infinite scroll
  list.onscroll = () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 10) {
      renderNextBatch(list);
    }
  };

  // ⏱️ 5️⃣ Auto-update "x minutes ago" labels every 60s
  setInterval(() => updateTimeAgoLabels(list), 60000);
}

// =========================================================
// 🔄 Infinite Scroll Renderer
// =========================================================
function renderNextBatch(list) {
  const nextItems = allActivityItems.slice(loadedCount, loadedCount + LOAD_BATCH_SIZE);
  if (nextItems.length === 0) return;
  renderGroupedActivities(list, nextItems);
  loadedCount += nextItems.length;
}

// =========================================================
// 🧩 Grouped Renderer
// =========================================================
function renderGroupedActivities(list, activities) {
  const sorted = activities.sort((a, b) => b.timestamp - a.timestamp);
  sorted.forEach((item) => {
    const groupLabel = getDateGroupLabel(item.timestamp);
    let groupEl = dateGroups[groupLabel];
    if (!groupEl) {
      groupEl = document.createElement("div");
      groupEl.className = "activity-group";
      groupEl.innerHTML = `<h3 class="activity-date">${groupLabel}</h3>`;
      dateGroups[groupLabel] = groupEl;
      list.appendChild(groupEl);
    }
    const el = createActivityElement(item);
    groupEl.appendChild(el);
  });
}

// =========================================================
// ➕ Prepend Real-Time Entry
// =========================================================
function prependActivity(list, item) {
  const groupLabel = getDateGroupLabel(item.timestamp);
  let groupEl = dateGroups[groupLabel];
  if (!groupEl) {
    groupEl = document.createElement("div");
    groupEl.className = "activity-group";
    groupEl.innerHTML = `<h3 class="activity-date">${groupLabel}</h3>`;
    list.prepend(groupEl);
    dateGroups[groupLabel] = groupEl;
  }
  const el = createActivityElement(item);
  groupEl.prepend(el);
  el.style.opacity = 0;
  setTimeout(() => (el.style.opacity = 1), 150);
}

// =========================================================
// 🧱 Activity Card Element
// =========================================================
function createActivityElement(item) {
  const el = document.createElement("div");
  el.className = "activity-item";
  el.dataset.timestamp = item.timestamp || Date.now();
  el.innerHTML = `
    <p><strong>${item.message || "Activity"}</strong></p>
    <small class="time-ago">${getTimeAgo(item.timestamp)}</small>
  `;
  return el;
}

// =========================================================
// ⏱️ Update all "time ago" labels
// =========================================================
function updateTimeAgoLabels(list) {
  list.querySelectorAll(".activity-item").forEach((el) => {
    const ts = Number(el.dataset.timestamp);
    const timeAgoEl = el.querySelector(".time-ago");
    if (timeAgoEl && ts) timeAgoEl.textContent = getTimeAgo(ts);
  });
}

// =========================================================
// 🕓 Relative Time ("x minutes ago")
// =========================================================
function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

// =========================================================
// 🗓️ Date Group Label (Today / Yesterday / 2 Days Ago)
// =========================================================
function getDateGroupLabel(ts) {
  const now = new Date();
  const date = new Date(ts);
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays === 2) return "2 Days Ago";
  return "Earlier";
}

// =========================================================
// 🔄 AUTO-REFRESH DELIVERY STATUS FOR ALL USERS (Optimized)
// =========================================================
function setupDeliveryRealtimeListeners() {
  const userId = auth.currentUser?.uid;
  if (!userId || !database) return;

  // 🧹 Cleanup existing listeners to avoid duplicates
  if (listeners['onProcessRealtime']) listeners['onProcessRealtime'].off();
  if (listeners['historyRealtime']) listeners['historyRealtime'].off();

  // 🔹 Live listener for changes in onProcess node
  const processRef = database.ref('onProcess');
  listeners['onProcessRealtime'] = processRef;

  processRef.on('value', (snap) => {
    if (!snap.exists()) return;

    let relevant = false;
    snap.forEach(child => {
      const d = child.val();
      if ([d.ownerId, d.userId, d.driverId].includes(userId)) {
        relevant = true;
      }
    });

    if (relevant) {
      loadOnProcess?.();
      loadPendingDeliveries?.();
      loadAdminTabs?.();
    }
  });

  // 🔹 Watch user-related history updates (delivery finalization)
  const histPaths = [
    `history/${userId}`,
    `driverHistory/${userId}`,
    `adminTransactions`
  ];

  histPaths.forEach(path => {
    const ref = database.ref(path);
    listeners[`historyRealtime_${path}`] = ref;
    ref.on('child_added', (snap) => {
      const h = snap.val();
      if (h) {
        loadOnProcess?.();
        loadPendingDeliveries?.();
        if (h.status) {
          const toast = document.createElement('div');
          toast.className = 'toast-message';
          toast.innerHTML = `<strong>📦 Delivery Update:</strong> ${h.product || 'Item'} → ${h.status}`;
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 3500);
        }
      }
    });
  });


  console.log('✅ Realtime delivery listeners active for', userId);
}
// Remove orders entries for buyer & owner when transaction is complete
async function removeOrderEntriesForTransaction(transactionId, data) {
  if (!transactionId || !data) return;
  const updates = {};
  if (data.buyerId) updates[`orders/${data.buyerId}/${transactionId}`] = null;
  if (data.ownerId) updates[`orders/${data.ownerId}/${transactionId}`] = null;
  if (Object.keys(updates).length === 0) return;
  await database.ref().update(updates);
  console.log(`🧹 Removed orders entries for transaction ${transactionId}`);
}
// =========================================================
// 🔄 FIXED: Update Deliveries Badge (auto-syncs with Firebase)
// ✅ Waits for Firebase sync before counting
// ✅ Ignores empty objects and completed/failed deliveries
// =========================================================
async function updateDeliveriesBadgeForUser(uid) {
  try {
    if (!uid) uid = auth.currentUser?.uid;
    if (!uid) return;

    // ⏳ Give Firebase a brief moment to apply recent deletions
    await new Promise(res => setTimeout(res, 500));

    let count = 0;

    // --- COUNT ACTIVE DELIVERIES ---
    const deliveriesSnap = await database.ref(`deliveries/${uid}`).once('value');
    if (deliveriesSnap.exists()) {
      const val = deliveriesSnap.val();
      for (const [tid, item] of Object.entries(val)) {
        if (!item) continue;
        const status = (item.status || '').trim();
        if (!['Completed', 'Failed', 'FailedDelivery', 'Delivered', 'deliveryfailed', 'deliverysuccess'].includes(status)) {
          count++;
        }
      }
    }

    // --- COUNT PENDING (optional for driver only) ---
    const userSnap = await database.ref('users/' + uid).once('value');
    const role = (userSnap.val()?.role || '').toLowerCase();
    if (role.includes('driver')) {
      const pendingSnap = await database.ref('pendingDeliveries').once('value');
      if (pendingSnap.exists()) {
        for (const [tid, p] of Object.entries(pendingSnap.val())) {
          if (p?.driverId === uid && !['Completed', 'Failed', 'Delivered'].includes((p.status || '').trim())) {
            count++;
          }
        }
      }
    }

    // --- UPDATE UI BADGE ---
    const badge = document.getElementById('deliveriesBadge');
    if (badge) {
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-flex';
      } else {
        badge.textContent = '';
        badge.style.display = 'none';
      }
    }

    console.log(`🚚 Deliveries badge updated: ${count} active`);
    return count;
  } catch (err) {
    console.warn('⚠️ Failed to update deliveries badge:', err);
  }
}


// ================= PICKUP HANDLER =================
function markPickedUp(id, r) {
  if (!r) return Swal.fire('Error', 'Record not found for this item.', 'error');
  if (!r.userId && !r.ownerId)
    return Swal.fire('Error', 'Cannot pick up: missing buyer/seller info.', 'error');

  if (r.type === 'delivery') {
    Swal.fire({
      title: 'Assign Rider & Set Delivery Payment',
      html: `
        <input id="sw_riderName" class="swal2-input" placeholder="Rider Name">
        <input id="sw_riderPhone" class="swal2-input" placeholder="Rider Phone">
        <input id="sw_deliveryPayment" type="number" class="swal2-input" placeholder="Delivery Payment (₱)">
      `,
      focusConfirm: false,
      showCancelButton: true,
      confirmButtonText: 'Confirm',
      preConfirm: () => {
        return {
          riderName: document.getElementById('sw_riderName').value.trim(),
          riderPhone: document.getElementById('sw_riderPhone').value.trim(),
          deliveryPayment: Number(document.getElementById('sw_deliveryPayment').value) || 0
        };
      }
    }).then(result => {
      if (result.isConfirmed) {
        const data = result.value;
        const updated = {
          ...r,
          status: 'ondelivery',
          deliveryPayment: data.deliveryPayment,
          riderName: data.riderName || '',
          riderPhone: data.riderPhone || ''
        };

        database.ref('onProcess/' + id).update(updated);
        if (r.userId) {
          database.ref('deliveries/' + r.userId + '/' + id).update(updated);
          pushTimeline(r.userId, id, 'picked up');
        }
        if (r.ownerId) database.ref('deliveries/' + r.ownerId + '/' + id).update(updated);

        addActivity(`Pickup: ${r.product || 'item'} — Payment ₱${data.deliveryPayment}`);
        Swal.fire('Updated', 'Delivery marked as on-delivery with rider info and payment', 'success');
      }
    });
  } else {
    const updated = { ...r, status: 'ondelivery' };
    database.ref('onProcess/' + id).update(updated);

    if (r.userId) {
      if (r.type === 'order') database.ref('orders/' + r.userId + '/' + id).update(updated);
      if (r.type === 'delivery') database.ref('deliveries/' + r.userId + '/' + id).update(updated);
      pushTimeline(r.userId, id, 'picked up');
    }

    if (r.ownerId) database.ref('deliveries/' + r.ownerId + '/' + id).update(updated);

    addActivity(`Pickup: ${r.product || 'item'}`);
  }
}

// ================= MOVE TO HISTORY =================
function moveToHistory(id, r, status){
  if(!id || !r) return;
  const finishedAt = Date.now();
  const finalStatus = (status === 'success') ? 'delivered' : status;

  const updated = { 
    ...r, 
    status: finalStatus, 
    finishedAt,
    riderName: r.riderName || '',
    riderPhone: r.riderPhone || ''
  };

  // --- 1. Admin records ---
  if(finalStatus === 'delivered'){
    // ✅ Delivered → goes to transactions
    database.ref('transactions/'+id).set(updated).catch(()=>{});
    Swal.fire('Completed','Item successfully delivered and recorded in Transactions','success');
  } else {
    // ❌ Failed/Declined → goes to admin history
    database.ref('adminHistory/'+id).set(updated).catch(()=>{});
    Swal.fire('Recorded','Item moved to Admin History with status: '+finalStatus,'info');
  }

  // --- 2. Customer side ---
  if(r.userId){
    if(r.type === 'order') database.ref('orders/'+r.userId+'/'+id).remove().catch(()=>{});
    database.ref('deliveries/'+r.userId+'/'+id).remove().catch(()=>{});
    database.ref('history/'+r.userId+'/'+id).set(updated).catch(()=>{});
    pushTimeline(r.userId, id, finalStatus);
  }

  // --- 3. Farmer side ---
  if(r.ownerId){
    database.ref('deliveries/'+r.ownerId+'/'+id).remove().catch(()=>{});
    database.ref('history/'+r.ownerId+'/'+id).set(updated).catch(()=>{});
  }

  // --- 4. Cleanup ---
  database.ref('onProcess/'+id).remove().catch(()=>{});

  // --- 5. Activity Log ---
  addActivity(`${(finalStatus||'').toUpperCase()}: ${r.product || 'item'}`);
}
// =========================================================
// 🧾 ADMIN HISTORY / TRANSACTIONS TAB (FINAL VERSION)
// ✅ Includes Buyer, Seller, Driver info with phone numbers
// ✅ Removed "Completed At" from the card
// ✅ Clean layout & consistent totals
// =========================================================
function loadAdminHistory() {
  if (!adminHistoryList) return;
  adminHistoryList.innerHTML = '<div class="loading-state">Loading transactions...</div>';
  let count = 0;

  // --- Render a single record card ---
  function renderRecord(h, id) {
    const tid = h.transactionId || id;
    const div = document.createElement('div');
    div.className = 'orders-card';

    const price = Number(h.price) || 0;
    const qty = Number(h.qty) || 0;
    const deliveryFee = Number(h.deliveryFee) || 0;
    const deliveryPayment = Number(h.deliveryPayment) || 0;
    const total = (price * qty) + deliveryFee + deliveryPayment;

    div.innerHTML = `
      <div>
        <p><strong>Transaction ID:</strong> ${tid}</p>
        <h4 style="font-weight:bold; text-transform:uppercase;">${h.product || 'Unknown Item'}</h4>

        <p><strong>Status:</strong> ${h.status || 'N/A'}</p>
        <p><strong>Quantity:</strong> ${qty} KG</p>
        ${h.price ? `<p><strong>Price per KG:</strong> ₱${h.price}</p>` : ''}
        ${deliveryFee ? `<p><strong>Delivery Fee:</strong> ₱${deliveryFee}</p>` : ''}
        ${deliveryPayment ? `<p><strong>Delivery Payment:</strong> ₱${deliveryPayment}</p>` : ''}

        <h4><strong>Total Payment:</strong> ₱${total.toLocaleString()}</h4>
        ${h.destination ? `<p><strong>Destination:</strong> ${h.destination}</p>` : ''}

        <hr>

        <p><strong>Buyer:</strong> ${h.buyerName || 'Unknown Buyer'} 
          <span class="contact">(${h.buyerPhone || 'No Number'})</span></p>

        <p><strong>Seller:</strong> ${h.ownerName || 'Unknown Seller'} 
          <span class="contact">(${h.ownerPhone || 'No Number'})</span></p>

        <p><strong>Driver:</strong> ${h.driverName || h.riderName || 'Unassigned Driver'} 
          <span class="contact">(${h.driverPhone || h.riderPhone || 'No Number'})</span></p>

        <hr>

        ${h.failReason ? `<p style="color:red"><strong>Failed Reason:</strong> ${h.failReason}</p>` : ''}
        ${h.declineReason ? `<p style="color:red"><strong>Decline Reason:</strong> ${h.declineReason}</p>` : ''}

        <button class="round-btn timeline-btn" data-id="${id}" title="View Timeline">
          <i class="fas fa-stream"></i>
        </button>
      </div>

      <span class="status ${h.status}">
        ${statusIcons[h.status] || '⏳'} ${h.status}
      </span>
    `;

    const btn = div.querySelector('.timeline-btn');
    if (btn) btn.onclick = () => showTimelineModal(h);

    adminHistoryList.appendChild(div);
    count++;
  }

  // --- Search filter ---
  const searchInput = document.getElementById('adminSearchId');
  const filter = searchInput ? searchInput.value.toLowerCase() : '';

  // --- Clear previous listeners ---
  if (listeners['transactions']) listeners['transactions'].off();
  if (listeners['adminHistory']) listeners['adminHistory'].off();

  // --- Combine both data sources (transactions + adminHistory) ---
  const txRef = database.ref('transactions');
  const histRef = database.ref('adminHistory');

  const allRecords = {};

  const renderAll = () => {
    adminHistoryList.innerHTML = '';
    const keys = Object.keys(allRecords).reverse();
    if (keys.length === 0) {
      adminHistoryList.innerHTML = `<div class="empty-state">No transactions found.</div>`;
      if (adminHistoryCountEl) adminHistoryCountEl.textContent = '0 (empty)';
      updateCartCounts();
      return;
    }

    keys.forEach(id => {
      const h = allRecords[id];
      const tid = h.transactionId || id;
      if (filter && !tid.toLowerCase().includes(filter)) return;
      renderRecord(h, id);
    });

    if (adminHistoryCountEl)
      adminHistoryCountEl.textContent = count > 0 ? count : '0 (empty)';
    updateCartCounts();
  };

  // --- Load both refs ---
  txRef.on('value', snap => {
    if (snap.exists()) {
      snap.forEach(child => {
        allRecords[child.key] = child.val();
      });
    }
    renderAll();
  });

  histRef.on('value', snap => {
    if (snap.exists()) {
      snap.forEach(child => {
        allRecords[child.key] = child.val();
      });
    }
    renderAll();
  });

  // --- Re-run filter when typing ---
  if (searchInput && !searchInput.hasListener) {
    searchInput.hasListener = true;
    searchInput.addEventListener('input', () => loadAdminHistory());
  }
}

function loadReports(){
  if(!reportsList) return;
  reportsList.innerHTML = '';

  const ref = database.ref('reports');
  if(listeners['reports']) listeners['reports'].off();
  listeners['reports'] = ref;

  ref.on('value', snap=>{
    reportsList.innerHTML = '';
    let count = 0;

    if(!snap.exists()){
      reportsList.innerHTML = `<div class="empty-state">No reports found.</div>`;
      count = 0;
    } else {
      snap.forEach(child=>{
        const r = child.val(), id = child.key;

        // Only show reports that are still pending
        if(r.status !== 'pending') return;  

        count++;
        const div = document.createElement('div');
        div.className = 'orders-card';

        div.innerHTML = `
          <div>
            <p><strong>Reported User:</strong> ${r.reportedName || r.reportedId || ''}</p>
            <p><strong>Reason:</strong> ${r.reason || ''}</p>
            <p><strong>Status:</strong> ${r.status || 'pending'}</p>
          </div>
          <div class="card-actions">
            <button class="round-btn admin-approve" title="Approve"><i class="fas fa-check"></i></button>
            <button class="round-btn admin-decline" title="Decline"><i class="fas fa-times"></i></button>
          </div>
        `;

        // 🔹 Approve button handler
        div.querySelector('.admin-approve').onclick = ()=> {
          approveReport(id, r);
          div.remove(); // ✅ instantly remove from UI
        };

        // 🔹 Decline button handler
        div.querySelector('.admin-decline').onclick = ()=> {
          declineReport(id);
          div.remove(); // ✅ instantly remove from UI
        };

        reportsList.appendChild(div);
      });
    }

    // 🔹 Update Reports tab counter
    const adminReportsCountEl = document.getElementById("adminReportsCount");
    if(adminReportsCountEl){
      adminReportsCountEl.textContent = count > 0 ? count : "0 (empty)";
    }

    updateCartCounts();
  });
}

function approveReport(reportId, r){
  if(!r.reportedId){
    Swal.fire('Error','Report missing reportedId. Cannot apply penalty.','error');
    return;
  }

  const userRef = database.ref('users/'+r.reportedId);
  userRef.once('value').then(snap=>{
    if(snap.exists()){
      const user = snap.val();
      let currentScore = (user.creditScore !== undefined) ? user.creditScore : 100;
      let newScore = currentScore - 20;
      if(newScore < 0) newScore = 0;

      let newStatus = user.status;
      if(newScore <= 0){
        newStatus = 'blacklisted'; // ✅ unified with your system
      }

      userRef.update({ creditScore: newScore, status: newStatus }).then(()=>{
        database.ref('reports/'+reportId+'/status').set('approved');
        addActivity(`⚠️ Report approved. User ${r.reportedId} lost 20 credits.`);
        Swal.fire('Approved',`Report approved. User ${r.reportedId} lost 20 credits.`,`success`);
      });
    } else {
      Swal.fire('Error','Reported user not found.','error');
    }
  });
}

function declineReport(reportId){
  database.ref('reports/'+reportId+'/status').set('declined');
  addActivity(`❌ Report ${reportId} declined by admin.`);
  Swal.fire('Declined','Report was declined.','info');
}

function unblockUser(uid){
  database.ref('users/'+uid).update({
    creditScore: 100,
    status: 'approved'   // ✅ consistent with your system
  }).then(()=>{
    Swal.fire('Unblocked','User has been unblocked and credit reset.','success');
  });
}

// ===== Account Management =====
function loadAccounts() {
  if (!adminPendingList || !adminApprovedList || !adminBlackList) return;

  adminPendingList.innerHTML = adminApprovedList.innerHTML = adminBlackList.innerHTML = '';
  const ref = database.ref('users');
  if (listeners['users']) listeners['users'].off();
  listeners['users'] = ref;

  ref.on('value', snap => {
    adminPendingList.innerHTML = adminApprovedList.innerHTML = adminBlackList.innerHTML = '';

    let hasPending = false; // ✅ Track if there are any pending users

    snap.forEach(child => {
      const u = child.val();
      const uid = child.key;

      const card = document.createElement('div');
      card.className = 'orders-card';

      // 🔹 Main info block
      let html = `
        <div style="flex:1">
          <h4>${u.name || u.email}</h4>
          <p>${u.email}</p>
          <p>Role: <strong>${u.role}</strong></p>
          <p>Status: <strong>${u.status}</strong></p>
      `;

      // ✅ Show "Registration Reason" only if status === 'pending'
      if (u.status === 'pending' && u.reason) {
        html += `
          <div style="
            margin-top:6px;
            background:#f8f9fa;
            padding:8px 10px;
            border-left:4px solid #0f9d58;
            border-radius:6px;
          ">
            <strong>Registration Reason:</strong><br>
            <span style="font-style:italic;">${u.reason}</span>
          </div>
        `;
      }

      // 🔹 Add decline or block reasons if present
      if (u.declineReason) {
        html += `<p style="color:#b94a48; margin-top:6px;"><strong>Decline Reason:</strong> ${u.declineReason}</p>`;
      }
      if (u.blockReason) {
        html += `<p style="color:#b94a48; margin-top:6px;"><strong>Block Reason:</strong> ${u.blockReason}</p>`;
      }

      html += `</div>`;
      card.innerHTML = html;

      // Controls container
      const controls = document.createElement('div');
      controls.className = 'card-actions';

      // Role selector
      const sel = document.createElement('select');
      ['customer', 'farmer', 'wholesaler', 'driver' , 'admin'].forEach(r => {
        const o = document.createElement('option');
        o.value = r;
        o.textContent = r;
        if (u.role === r) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        database.ref('users/' + uid).update({ role: sel.value });
        Swal.fire('Updated', 'Role changed', 'success');
      });
      controls.appendChild(sel);

      // Buttons based on status
      if (u.status === 'pending') {
        hasPending = true; // ✅ Found at least one pending user

        const approveBtn = document.createElement('button');
        approveBtn.textContent = 'Approve';
        approveBtn.className = 'admin-approve';
        approveBtn.addEventListener('click', () => {
          database.ref('users/' + uid).update({
            status: 'approved',
            approvedAt: Date.now()
          });
          Swal.fire('Approved', 'User approved', 'success');
        });

        const declineBtn = document.createElement('button');
        declineBtn.textContent = 'Decline';
        declineBtn.className = 'admin-decline';
        declineBtn.addEventListener('click', () => {
          Swal.fire({
            title: 'Reason for Decline',
            input: 'text',
            inputPlaceholder: 'Enter reason (e.g. Fake account, Incomplete details)',
            showCancelButton: true,
            confirmButtonText: 'Submit'
          }).then(res => {
            if (!res.isConfirmed) return;
            const reason = res.value || 'No reason provided';
            database.ref('users/' + uid).update({
              status: 'declined',
              declineReason: reason,
              declinedAt: Date.now()
            });
            Swal.fire('Declined', 'User declined. Reason: ' + reason, 'info');
          });
        });

        controls.appendChild(approveBtn);
        controls.appendChild(declineBtn);
      } else if (u.status === 'approved') {
        const blockBtn = document.createElement('button');
        blockBtn.textContent = 'Block';
        blockBtn.className = 'admin-block';
        blockBtn.addEventListener('click', () => {
          Swal.fire({
            title: 'Reason for Blocking',
            input: 'text',
            inputPlaceholder: 'Enter reason (e.g. Abusive behavior)',
            showCancelButton: true,
            confirmButtonText: 'Block'
          }).then(res => {
            if (!res.isConfirmed) return;
            const reason = res.value || 'No reason provided';
            database.ref('users/' + uid).update({
              status: 'blacklisted',
              blockReason: reason,
              blockedAt: Date.now()
            });
            Swal.fire('Blocked', 'User has been blacklisted. Reason: ' + reason, 'success');
          });
        });
        controls.appendChild(blockBtn);
      } else {
        const unblockBtn = document.createElement('button');
        unblockBtn.textContent = 'Unblock';
        unblockBtn.className = 'admin-success';
        unblockBtn.addEventListener('click', () => {
          database.ref('users/' + uid).update({
            status: 'approved',
            unblockedAt: Date.now()
          });
          Swal.fire('Unblocked', 'User approved again', 'success');
        });
        controls.appendChild(unblockBtn);
      }

      card.appendChild(controls);

      // Sort into correct list
      if (u.status === 'pending') adminPendingList.appendChild(card);
      else if (u.status === 'approved') adminApprovedList.appendChild(card);
      else adminBlackList.appendChild(card);
    });

    // ✅ Show "no pending" message if empty
    if (!hasPending) {
      adminPendingList.innerHTML = `<div class="empty-state">No pending accounts to review.</div>`;
    }
  });
}

// ===== Profile =====
function loadProfile(uid) {
  if (!uid) return;
  const ref = database.ref('users/' + uid);

  if (listeners['profile_' + uid]) listeners['profile_' + uid].off();
  listeners['profile_' + uid] = ref;

  ref.on('value', snap => {
    const u = snap.val() || {};

    
    if (profileNameDisplay) profileNameDisplay.textContent = u.name || '';
    if (profileEmailDisplay) profileEmailDisplay.textContent = u.email || (auth.currentUser && auth.currentUser.email) || '';
    if (profilePhoneDisplay) profilePhoneDisplay.textContent = u.phone || '';
    if (profileAddressDisplay) profileAddressDisplay.textContent = u.address || '';
    if (profileRoleDisplay) profileRoleDisplay.textContent = u.role || 'buyer';

    // 🔹 Credit Score directly from Firebase
    if (profileCreditScoreDisplay) {
      if (u.creditScore !== undefined && u.creditScore !== null) {
        profileCreditScoreDisplay.textContent = u.creditScore;
      } else {
        profileCreditScoreDisplay.textContent = 'N/A'; // or '0' if you want default
      }
    }
  });
}
// ================= RECENT ACTIVITIES FEED (ADMIN TRANSACTIONS) =================

// 🕒 Utility: format how long ago
function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

function loadRecentActivities() {
  const list = document.getElementById('activityList');
  if (!list) return;
  list.innerHTML = '<div class="loading">Loading recent activities...</div>';

  const items = [];
  const uid = auth.currentUser?.uid;

  // Helper to process entries
  function addEntry(tx, source = 'system') {
    if (!tx) return;
    const isSuccess =
      (tx.status && ['success', 'delivered', 'completed', 'done'].includes(tx.status.toLowerCase())) ||
      tx.finishedAt || tx.deliveredAt || tx.completedAt;

    if (!isSuccess) return;

    const username = tx.buyerName || tx.userName || tx.customerName || tx.sellerName || 'User';
    const product = tx.product || tx.item || 'Item';
    const type =
      (tx.type && tx.type.toLowerCase().includes('buy')) ||
      (tx.category && tx.category.toLowerCase().includes('purchase'))
        ? 'bought'
        : (tx.type === 'delivery' ? 'delivered' : 'transaction');

    items.push({
      message: `${username} successfully ${type} ${product}`,
      timestamp: tx.finishedAt || tx.deliveredAt || tx.completedAt || tx.timestamp || Date.now(),
      source
    });
  }

  // 🟢 Listen to adminHistory
  const adminRef = database.ref('adminHistory').limitToLast(50);
  if (listeners['activities_admin']) listeners['activities_admin'].off();
  listeners['activities_admin'] = adminRef;
  adminRef.on('value', snap => {
    snap.forEach(child => addEntry(child.val(), 'adminHistory'));
    renderActivities();
  });

  // 🟢 Listen to user’s personal history
  if (uid) {
    const userRef = database.ref('history/' + uid).limitToLast(50);
    if (listeners['activities_user']) listeners['activities_user'].off();
    listeners['activities_user'] = userRef;
    userRef.on('value', snap => {
      snap.forEach(child => addEntry(child.val(), 'userHistory'));
      renderActivities();
    });
  }

  // 🟢 Listen to global transactions (successful ones)
  const txRef = database.ref('transactions').limitToLast(50);
  if (listeners['activities_tx']) listeners['activities_tx'].off();
  listeners['activities_tx'] = txRef;
  txRef.on('value', snap => {
    snap.forEach(child => addEntry(child.val(), 'transactions'));
    renderActivities();
  });

  // 🔄 Render list
  function renderActivities() {
    if (items.length === 0) {
      list.innerHTML = `<div class="empty-state">No recent activities yet.</div>`;
      return;
    }

    const unique = [];
    const seen = new Set();
    for (const a of items) {
      const key = `${a.message}-${a.timestamp}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(a);
      }
    }

    unique.sort((a, b) => b.timestamp - a.timestamp);
    list.innerHTML = unique
      .map(a => `
        <div class="activity-item">
          <p>${a.message}</p>
          <small>${timeAgo(a.timestamp)}</small>
        </div>
      `)
      .join('');

    startInfiniteScroll(list);
  }
}

// ♻️ Infinite scroll loop with fade + seamless looping
function startInfiniteScroll(container) {
  if (!container) return;
  container.style.overflow = "hidden"; // disable manual scroll
  container.style.position = "relative";

  // Create top/bottom fade overlay if not exists
  if (!container.querySelector(".fade-overlay-top")) {
    const fadeTop = document.createElement("div");
    fadeTop.className = "fade-overlay-top";
    const fadeBottom = document.createElement("div");
    fadeBottom.className = "fade-overlay-bottom";
    Object.assign(fadeTop.style, {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "30px",
      background: "linear-gradient(to bottom, var(--bg), transparent)",
      pointerEvents: "none",
      zIndex: 2
    });
    Object.assign(fadeBottom.style, {
      position: "absolute",
      bottom: 0,
      left: 0,
      width: "100%",
      height: "30px",
      background: "linear-gradient(to top, var(--bg), transparent)",
      pointerEvents: "none",
      zIndex: 2
    });
    container.appendChild(fadeTop);
    container.appendChild(fadeBottom);
  }

  let scrollPos = 0;
  const speed = 0.4; // adjust smoothness
  let fading = false;

  function scrollStep() {
    const maxScroll = container.scrollHeight - container.clientHeight;
    if (maxScroll > 0) {
      scrollPos += speed;
      if (scrollPos >= maxScroll) {
        // fade-out, reset, fade-in loop
        if (!fading) {
          fading = true;
          container.style.transition = "opacity 0.8s ease";
          container.style.opacity = 0.3;
          setTimeout(() => {
            scrollPos = 0;
            container.scrollTop = 0;
            container.style.opacity = 1;
            fading = false;
          }, 800);
        }
      }
      container.scrollTop = scrollPos;
    }
    requestAnimationFrame(scrollStep);
  }

  requestAnimationFrame(scrollStep);
}


// 🟢 Auto-start when user logs in
function initActivityFeedAuto() {
  const list = document.getElementById('activityList');
  if (list) {
    loadRecentActivities();
  }
}
// === Auto-scroll Activity Log and Modal Handling ===
function initActivityLogFeatures() {
  const activityList = document.getElementById('activityList');
  const activityModal = document.getElementById('activityModal');
  const detailText = document.getElementById('activityDetailText');
  const closeBtn = document.getElementById('closeActivityModal');

  // ✅ Auto-scroll to bottom (newest logs)
  function scrollToLatest() {
    if (activityList) {
      activityList.scrollTop = activityList.scrollHeight;
    }
  }

  // Run once when page loads
  scrollToLatest();

  // Optional: Re-scroll automatically if new log item added
  const observer = new MutationObserver(scrollToLatest);
  if (activityList) observer.observe(activityList, { childList: true });

  // ✅ Click any log item to show modal
  if (activityList) {
    activityList.addEventListener('click', e => {
      const item = e.target.closest('.activity-log-item');
      if (!item) return;
      const detail = item.dataset.detail || item.querySelector('strong')?.innerText || 'No details available.';
      detailText.textContent = detail;
      activityModal.classList.remove('hidden');
      activityModal.classList.add('show');
    });
  }

  // ✅ Close modal
  if (closeBtn) closeBtn.onclick = () => {
    activityModal.classList.remove('show');
    setTimeout(() => activityModal.classList.add('hidden'), 200);
  };

  // ✅ Close modal when clicking outside
  activityModal.addEventListener('click', e => {
    if (e.target === activityModal) {
      activityModal.classList.remove('show');
      setTimeout(() => activityModal.classList.add('hidden'), 200);
    }
  });
}

// Initialize when DOM ready
document.addEventListener('DOMContentLoaded', initActivityLogFeatures);

// ===== Delivery actions (user) =====
function markDeliveryReceived(uid, id, r){
  Swal.fire({
    title: 'Confirm received?',
    text: 'Mark this delivery as received and move to your history.',
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'Yes, received'
  }).then(res=>{
    if(!res.isConfirmed) return;
    const updated = {...r, status:'success', receivedAt: Date.now()};
    if(uid){
      database.ref('history/'+uid+'/'+id).set(updated);
      pushTimeline(uid, id, 'received'); // 👈
    }
    database.ref('adminHistory/'+id).set(updated);
    if(uid) database.ref('deliveries/'+uid+'/'+id).remove();
    database.ref('onProcess/'+id).remove();
    Swal.fire('Done','Marked as received','success');
    addActivity(`Received: ${r.product||''}`);
  });
}

function markDeliveryCanceled(uid, id, r){
  Swal.fire({
    title: 'Cancel delivery?',
    text: 'This will mark the delivery as canceled.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Yes, cancel'
  }).then(res=>{
    if(!res.isConfirmed) return;
    const updated = {...r, status:'canceled', canceledAt: Date.now()};
    if(uid){
      database.ref('history/'+uid+'/'+id).set(updated);
      pushTimeline(uid, id, 'canceled'); // 👈
    }
    database.ref('adminHistory/'+id).set(updated);
    if(uid) database.ref('deliveries/'+uid+'/'+id).remove();
    database.ref('onProcess/'+id).remove();
    Swal.fire('Canceled','Delivery marked as canceled','info');
    addActivity(`Canceled: ${r.product||''}`);
  });
}


// ===== Cleanup =====
window.addEventListener('beforeunload', ()=> {
  Object.keys(listeners).forEach(k => { try{ listeners[k].off(); } catch(e){} });
});

// ===== ✅ Accurate Badge Counts =====
function updateCartCounts() {
  try {
    const countVisibleItems = (selector) => {
      const items = document.querySelectorAll(`${selector} > *`);
      if (!items.length) return 0;
      // Count only cards, not .empty-state or .loading-state
      let count = 0;
      items.forEach(el => {
        if (!el.classList.contains('empty-state') && !el.classList.contains('loading-state')) {
          count++;
        }
      });
      return count;
    };

    const setBadge = (el, count) => {
      if (!el) return;
      el.textContent = count > 0 ? count : '';
      el.style.display = count > 0 ? 'inline-flex' : 'none';
    };

    // 🔢 Update counts safely
    setBadge(ordersCountEl, countVisibleItems('#ordersList'));
    setBadge(deliveriesCountEl, countVisibleItems('#deliveriesList'));
    setBadge(historyCountEl, countVisibleItems('#historyList'));
    setBadge(adminPendingCountEl, countVisibleItems('#pendingAdminList'));
    setBadge(adminOnProcessCountEl, countVisibleItems('#onProcessAdminList'));
    setBadge(adminHistoryCountEl, countVisibleItems('#adminHistoryList'));

  } catch (e) {
    console.error('updateCartCounts error:', e);
  }
}

// =========================================================
// 🧭 ACTIVITY LOG HELPERS (Notifications & Timeline)
// =========================================================

// 🔹 Logs messages for any user (buyer, farmer, driver, etc.)
function pushTimeline(userId, transactionId, message) {
  if (!userId) return;

  const ref = database.ref('userTimeline/' + userId).push();
  const data = {
    transactionId: transactionId || 'N/A',
    message: message || '',
    timestamp: Date.now(),
    date: new Date().toLocaleString()
  };

  ref.set(data).catch(err => console.error('pushTimeline error:', err));
}

// 🔹 Logs admin-wide system activity
function addActivity(logText) {
  if (!logText) return;

  const ref = database.ref('adminActivity').push();
  const data = {
    activity: logText,
    actor: auth.currentUser?.uid || 'system',
    actorName: auth.currentUser?.displayName || 'Admin',
    timestamp: Date.now(),
    date: new Date().toLocaleString()
  };

  ref.set(data).catch(err => console.error('addActivity error:', err));
}

// =========================================================
// 🧭 LOAD ADMIN ACTIVITY (Interactive + Auto-Trim + Newest First)
// =========================================================
function loadAdminActivity() {
  const logContainer = document.getElementById('adminActivityLog');
  if (!logContainer) return;

  const ref = database.ref('adminActivity').orderByChild('timestamp');
  ref.on('value', snap => {
    logContainer.innerHTML = '';
    if (!snap.exists()) {
      logContainer.innerHTML = `<div class="empty-state">No recent activities yet.</div>`;
      return;
    }

    const logs = [];
    snap.forEach(child => {
      const entry = { id: child.key, ...child.val() };
      logs.push(entry);
    });

    // ✅ Sort newest first
    logs.sort((a, b) => b.timestamp - a.timestamp);

    // ✅ Auto-trim to 50 latest
    if (logs.length > 50) {
      const toRemove = logs.slice(50);
      toRemove.forEach(old => {
        database.ref('adminActivity/' + old.id).remove().catch(() => {});
      });
    }

    const latestLogs = logs.slice(0, 50);

    latestLogs.forEach(log => {
      const div = document.createElement('div');
      div.className = 'activity-log-item';
      div.innerHTML = `
        <p><strong>${log.actorName || 'Admin'}</strong>: ${log.activity}</p>
        <small>${new Date(log.timestamp).toLocaleString()}</small>
      `;

      // 🟢 Make log clickable — show details
      div.addEventListener('click', () => {
        Swal.fire({
          title: '📝 Activity Details',
          html: `
            <div style="text-align:left; font-size:14px;">
              <p><strong>Actor:</strong> ${log.actorName || 'Admin'}</p>
              <p><strong>Actor UID:</strong> ${log.actor || 'N/A'}</p>
              <p><strong>Activity:</strong><br>${log.activity || 'No details'}</p>
              ${log.transactionId ? `<p><strong>Transaction ID:</strong> ${item.transactionId || id}</p>` : ''}
              <p><strong>Date & Time:</strong><br>${new Date(log.timestamp).toLocaleString()}</p>
            </div>
          `,
          confirmButtonText: 'Close',
          confirmButtonColor: '#4caf50'
        });
      });

      logContainer.appendChild(div);
    });

    // 🟢 Smooth scroll to top when new logs appear
    logContainer.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  });
}


function updateAdminCounts(){
  try {
    adminOnProcessCountEl && (adminOnProcessCountEl.textContent = document.querySelectorAll('#onProcessAdminList > :not(.empty-state)').length);
    adminHistoryCountEl && (adminHistoryCountEl.textContent = document.querySelectorAll('#adminHistoryList > :not(.empty-state)').length);
  } catch(e){}
}
attachCartVisualHandlers();
attachNavHandlers();
attachHomeTabHandlers();
attachCartTabHandlers();
attachAdminTabHandlers();
setTimeout(updateCartCounts, 500);
setInterval(updateCartCounts, 3000);

// === Dynamically create Pickup Modal (ensures it exists) ===
(function(){
    if (!document.getElementById('pickupModal')) {
        const modalHTML = `
        <div id="pickupModal" class="modal hidden">
          <div class="modal-content">
            <h3>Pickup Details</h3>
            <input type="text" id="pickupRiderName" placeholder="Rider Name">
            <input type="text" id="pickupRiderPhone" placeholder="Rider Phone">
            <button id="pickupConfirm">Confirm</button>
            <button id="pickupCancel">Cancel</button>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }
})();

// === Pickup Modal Event Handlers (reliable delegated binding) ===
let pickupTargetId = null;
document.addEventListener('click', function(e){
    const btn = e.target.closest('.pickup-btn');
    if(btn){
        pickupTargetId = btn.dataset.id;
        document.getElementById('pickupRiderName').value = '';
        document.getElementById('pickupRiderPhone').value = '';
        document.getElementById('pickupModal').style.display = 'block';
    }
});

document.addEventListener('click', function(e){
    if(e.target && e.target.id === 'pickupConfirm'){
        const name  = document.getElementById('pickupRiderName').value.trim();
        const phone = document.getElementById('pickupRiderPhone').value.trim();
        const price = document.getElementById('pickupDeliveryPrice') 
                      ? document.getElementById('pickupDeliveryPrice').value.trim() 
                      : ""; // new field for delivery price

        if (!name || !phone || !price) { 
            alert('Please enter rider name, phone, and delivery price.'); 
            return; 
        }

        const ref = database.ref(`deliveries/${pickupTargetId}`);
        ref.once('value').then(snap=>{
            const data = snap.val();
            if (data) {
                ref.update({
                    status: 'ondelivery',
                    riderName: name,
                    riderPhone: phone,
                    deliveryPrice: price,   // ✅ new field saved
                    pickupAt: Date.now()
                });
            }
        });
        document.getElementById('pickupModal').style.display = 'none';
    }

    if(e.target && e.target.id === 'pickupCancel'){
        document.getElementById('pickupModal').style.display = 'none';
    }
});



// ===== Open timeline modal and load entries =====
function openTimeline(uid, transactionId) {
  if (!timelineModal || !timelineList) return;
  timelineList.innerHTML = `<p>Loading timeline...</p>`;
  timelineModal.classList.remove("hidden");

  const ref = database.ref(`timeline/${uid}/${transactionId}`);

  ref.once("value")
    .then((snap) => {
      if (!snap.exists()) {
        timelineList.innerHTML = `<p>No timeline activity yet for this transaction.</p>`;
        return;
      }

      let html = "";
      snap.forEach((child) => {
        const t = child.val();
        const date = new Date(t.time || Date.now()).toLocaleString();
        html += `
          <p>🕒 <strong>${date}</strong> — ${t.action || "Updated"}</p>
        `;
      });

      timelineList.innerHTML = html;
    })
    .catch((err) => {
      console.error(err);
      timelineList.innerHTML = `<p style="color:red;">Error loading timeline: ${err.message}</p>`;
    });
}
if (closeTimelineBtn) {
  closeTimelineBtn.addEventListener("click", () => {
    timelineModal.classList.add("hidden");
  });
}

// ✅ APPLY + INBOX LOGIC (customer + admin view)

// --- SETUP ON LOGIN ---
auth.onAuthStateChanged(user => {
  if (!user) return;

  const uid = user.uid;
  const nameInput = document.getElementById('applyName');
  const applyNav = document.getElementById('applyNav');
  const applyFormTab = document.getElementById('applyFormTab');
  const inboxTab = document.getElementById('inboxTab');
  const applyTabBtn = document.getElementById('applyTabBtn');
  const inboxTabBtn = document.getElementById('inboxTabBtn');

  // ✅ Ensure Apply Nav always visible for both admin & customer
  if (applyNav) applyNav.classList.remove('hidden');

  // ✅ Auto-fill name
  if (nameInput) {
    database.ref('users/' + uid + '/name').once('value').then(snap => {
      nameInput.value = snap.val() || user.displayName || '';
    });
  }

  // ✅ Detect role and handle visibility
  database.ref('users/' + uid + '/role').once('value').then(roleSnap => {
    const role = roleSnap.val();

    // Admin can always view both tabs
    if (role === 'admin') {
      applyFormTab?.classList.remove('hidden');
      inboxTab?.classList.add('hidden');
      if (applyTabBtn) applyTabBtn.classList.add('active');
      if (inboxTabBtn) inboxTabBtn.classList.remove('active');
      setupTabSwitching();
      return;
    }

    // For non-admin users: check their application status
    database.ref('applications/' + uid).once('value').then(appSnap => {
      if (!appSnap.exists()) {
        // No app yet — show Apply tab
        applyFormTab?.classList.remove('hidden');
        inboxTab?.classList.add('hidden');
        applyTabBtn?.classList.add('active');
        inboxTabBtn?.classList.remove('active');
      } else {
        const app = appSnap.val();
        // If pending or approved → show inbox only
        if (app.status === 'pending' || app.status === 'approved') {
          applyFormTab?.classList.add('hidden');
          inboxTab?.classList.remove('hidden');
          inboxTabBtn?.classList.add('active');
          applyTabBtn?.classList.remove('active');
          loadInbox();
        } else {
          // If declined → show Apply form again
          applyFormTab?.classList.remove('hidden');
          inboxTab?.classList.add('hidden');
          applyTabBtn?.classList.add('active');
          inboxTabBtn?.classList.remove('active');
        }
      }
      setupTabSwitching();
    });
  });
});
window.addEventListener('load', () => {
  auth.onAuthStateChanged(user => {
    if (user) {
      database.ref('users/' + user.uid).once('value').then(snap => {
        const u = snap.val();
        if (u && u.status === 'approved') {
          currentUserRole = u.role || 'customer';
          showAppForUser(u);
        } else if (u && u.status === 'blacklisted') {
          Swal.fire('Blocked', 'Your account has been blacklisted.', 'error')
            .then(() => {
              auth.signOut();
              showSignedOut();
            });
        } else {
          auth.signOut();
          showSignedOut();
        }
      }).catch(() => showSignedOut());
    } else {
      showSignedOut();
    }
  });
});


// ✅ Handle Apply ↔ Inbox switching
function setupTabSwitching() {
  const applyTabBtn = document.getElementById('applyTabBtn');
  const inboxTabBtn = document.getElementById('inboxTabBtn');
  const applyFormTab = document.getElementById('applyFormTab');
  const inboxTab = document.getElementById('inboxTab');

  if (applyTabBtn && inboxTabBtn && applyFormTab && inboxTab) {
    applyTabBtn.onclick = () => {
      applyFormTab.classList.remove('hidden');
      inboxTab.classList.add('hidden');
      applyTabBtn.classList.add('active');
      inboxTabBtn.classList.remove('active');
    };

    inboxTabBtn.onclick = () => {
      inboxTab.classList.remove('hidden');
      applyFormTab.classList.add('hidden');
      inboxTabBtn.classList.add('active');
      applyTabBtn.classList.remove('active');
      loadInbox();
    };
  }
}


// ===========================
// ✅ APPLY AS WHOLESALER LOGIC
// ===========================
document.getElementById('applySubmitBtn')?.addEventListener('click', async () => {
  const uid = auth.currentUser?.uid;
  if (!uid) return Swal.fire('Error', 'You must be logged in first.', 'error');

  const name = document.getElementById('applyName').value.trim();
  const reason = document.getElementById('applyReason').value.trim();

  if (!reason) {
    Swal.fire('Missing Info', 'Please enter your reason or business details.', 'warning');
    return;
  }

  const confirm = await Swal.fire({
    title: 'Submit Application?',
    text: 'You are applying for a Wholesaler role (buy and sell access). Continue?',
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'Yes, Submit',
    cancelButtonText: 'Cancel',
  });

  if (!confirm.isConfirmed) return;

  const appRef = database.ref('applications/' + uid);

  appRef.once('value').then(snap => {
    if (snap.exists()) {
      const app = snap.val();

      if (app.status === 'pending') {
        Swal.fire('Already Submitted', 'You already have a pending application.', 'info');
        return;
      }
      if (app.status === 'approved') {
        Swal.fire('Approved', 'You are already a wholesaler.', 'success');
        return;
      }
      if (app.status === 'declined') {
        submitApplication(uid, name, reason, appRef, true);
        return;
      }
    } else {
      submitApplication(uid, name, reason, appRef, false);
    }
  }).catch(err => Swal.fire('Error', err.message, 'error'));
});


// ✅ Helper: Send Application Data to Firebase
function submitApplication(uid, name, reason, appRef, isReapply = false) {
  const appData = {
    uid,
    name,
    reason,
    status: 'pending',
    submittedAt: Date.now(),
    ...(isReapply ? { reapply: true } : {})
  };

  appRef.set(appData)
    .then(() => {
      Swal.fire(
        isReapply ? 'Reapplied!' : 'Application Sent!',
        isReapply
          ? 'Your reapplication has been sent for admin review.'
          : 'Your wholesaler application was successfully submitted.',
        'success'
      );
      document.getElementById('applyReason').value = '';
      loadInbox();
    })
    .catch(err => Swal.fire('Error', err.message, 'error'));
}


// ✅ Load Application Inbox for Current User
function loadInbox() {
  const inboxList = document.getElementById('inboxList');
  const uid = auth.currentUser?.uid;
  if (!inboxList || !uid) return;

  inboxList.innerHTML = `<div class="empty-state">Loading your application status...</div>`;

  database.ref('applications/' + uid).on('value', snap => {
    inboxList.innerHTML = '';

    if (!snap.exists()) {
      inboxList.innerHTML = `<div class="empty-state">No application found.</div>`;
      return;
    }

    const app = snap.val();
    const statusClass =
      app.status === 'approved' ? 'success' :
      app.status === 'declined' ? 'danger' : 'pending';
    const statusText =
      app.status === 'approved' ? '✅ Approved' :
      app.status === 'declined' ? '❌ Declined' : '🕒 Pending Review';

    const div = document.createElement('div');
    div.className = 'auth-panel';
    div.innerHTML = `
      <h4>${app.name || 'Your Application'}</h4>
      <p><strong>Status:</strong> <span class="status ${statusClass}">${statusText}</span></p>
      <p><strong>Reason:</strong> ${app.reason || 'N/A'}</p>
      ${
        app.status === 'declined' && app.declineReason
          ? `<p><strong>Decline Reason:</strong> ${app.declineReason}</p>`
          : ''
      }
    `;
    inboxList.appendChild(div);
  });
}


// DEVELOPED BY: ABOTKAMAY TEAM 🔰