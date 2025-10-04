import { ageFromBirthdate, allowedPairing, el } from './utils.js';

// Firebase (compat)
const app = firebase.initializeApp(window.firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

/* ==============================
   Routing helpers
============================== */
const routes = {
  '': renderCreate,
  '#/create': renderCreate,
  '#/inbox': renderInbox,
  '#/me': renderMe,
  '#/auth': renderAuth,
  '#/messages': renderMessages,
};

function isHandle(s){ return /^@[\w.\-]{2,30}$/.test(s); }
function deepLink(){
  const p = location.pathname;
  const m1 = p.match(/^\/(@[\w.\-]{2,30})$/);
  if (m1) return { kind:'handle', value:m1[1] };
  const m2 = p.match(/^\/p\/([A-Za-z0-9_-]{6,})$/);
  if (m2) return { kind:'uid', value:m2[1] };
  const u = new URLSearchParams(location.search).get('u');
  if (u) return { kind:'handle', value: '@' + u.replace(/^@/, '') };
  const h = location.hash;
  if (h.startsWith('#/@') && isHandle(h.slice(2))) return { kind:'handle', value:h.slice(1) };
  return null;
}

window.addEventListener('hashchange', mount);
window.addEventListener('popstate', mount);
window.addEventListener('load', mount);

document.getElementById('btn-create').onclick   = ()=> location.hash = '#/create';
document.getElementById('btn-inbox').onclick    = ()=> location.hash = '#/inbox';
document.getElementById('btn-profile').onclick  = ()=> location.hash = '#/me';
document.getElementById('btn-auth').onclick     = ()=> location.hash = '#/auth';
document.getElementById('btn-messages').onclick = ()=> location.hash = '#/messages';

function toast(m){ alert(m); }

async function mount(){
  const root = document.getElementById('app');
  root.innerHTML = '';
  const link = deepLink();
  if (link){
    if (link.kind === 'handle') return renderViewByHandle(link.value);
    if (link.kind === 'uid')    return renderViewByUid(link.value);
  }
  const fn = routes[location.hash || '#/create'] || renderCreate;
  await fn();
}

/* ==============================
   Local cache keys
============================== */
const LS = {
  draftQuestions: 'lynctree_draft_questions',
  pendingAnswers: targetUid => `pending_answers_${targetUid}`,
  pendingTarget: 'pending_target_uid',
  pendingRedirect: 'pending_redirect_after_auth'
};

/* ==============================
   Auth watcher: auto-finish pending submission
============================== */
auth.onAuthStateChanged(async (u)=>{
  const target = localStorage.getItem(LS.pendingTarget);
  const redirect = localStorage.getItem(LS.pendingRedirect);
  if (u && target){
    try{
      const stored = JSON.parse(localStorage.getItem(LS.pendingAnswers(target)) || '[]');
      await submitAnswersFlow(target, stored);
      toast('Submitted!');
    }catch(e){
      console.warn('Auto-submit failed:', e);
      toast(e?.message || 'Submission failed after sign-in.');
    }finally{
      localStorage.removeItem(LS.pendingAnswers(target));
      localStorage.removeItem(LS.pendingTarget);
      localStorage.removeItem(LS.pendingRedirect);
      if (redirect) location.href = redirect;
      else location.hash = '#/inbox';
    }
  }
});

/* ==============================
   CREATE (p1 writes questions)
============================== */
async function renderCreate(){
  const root = document.getElementById('app');
  const tpl = document.getElementById('tpl-create');
  root.appendChild(tpl.content.cloneNode(true));

  const list = document.getElementById('question-list');
  const addBtn = document.getElementById('add-q');
  const saveBtn = document.getElementById('save-draft');
  const publishBtn = document.getElementById('publish');

  (JSON.parse(localStorage.getItem(LS.draftQuestions) || '[]'))
    .forEach((q,i)=> list.appendChild(makeBubble(q, i)));
  if (list.children.length === 0){
    add('What’s your ideal lazy day?');
    add('Two truths and a lie about you?');
  }
  renumber();

  addBtn.onclick = ()=> add('What makes you laugh unexpectedly?');
  saveBtn.onclick = ()=>{
    localStorage.setItem(LS.draftQuestions, JSON.stringify(collect()));
    toast('Draft saved locally.');
  };
  publishBtn.onclick = async ()=>{
    const qs = collect();
    if (qs.length < 2) return toast('Minimum 2 questions.');
    if (!auth.currentUser){ await renderAuth(); if (!auth.currentUser) return; }
    await ensureProfile(auth.currentUser.uid);
    await db.collection('profiles').doc(auth.currentUser.uid).set({
      questions: qs,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
    localStorage.setItem(LS.draftQuestions, JSON.stringify(qs));
    toast('Published! Share your link from Me.');
    location.hash = '#/me';
  };

  function collect(){
    const out = [];
    list.querySelectorAll('.bubble textarea').forEach(t => {
      const v = t.value.trim();
      if (v) out.push(v.slice(0,120));
    });
    return out;
  }
  function add(preset=''){
    const count = list.querySelectorAll('.bubble').length;
    if (count >= 7) return toast('Limit is 7 questions.');
    list.appendChild(makeBubble(preset, count));
    renumber();
  }
  function renumber(){
    [...list.querySelectorAll('.bubble label')].forEach((lab, idx)=> lab.textContent = 'Question ' + (idx+1));
    const canDelete = list.querySelectorAll('.bubble').length > 2;
    list.querySelectorAll('.btn-del').forEach(btn=> btn.disabled = !canDelete);
  }
  function makeBubble(text, index){
    const del = el('button', { class:'btn icon btn-del', title:'Delete', onclick: (e)=>{
      e.preventDefault();
      const count = list.querySelectorAll('.bubble').length;
      if (count <= 2) return toast('You need at least 2 questions.');
      e.currentTarget.closest('.bubble').remove();
      renumber();
    } }, '✕');
    return el('div', { class:'bubble card' }, [
      el('div', { class:'bubble-toolbar' }, [del]),
      el('label', {}, 'Question ' + (index+1)),
      el('textarea', { placeholder:'Type your playful prompt (max ~120 chars)' }, text)
    ]);
  }
}

/* ==============================
   AUTH (email+password only)
============================== */
async function renderAuth(){
  const root = document.getElementById('app');
  root.innerHTML = '';
  const tpl = document.getElementById('tpl-auth');
  root.appendChild(tpl.content.cloneNode(true));

  const tabIn = document.getElementById('tab-signin');
  const tabCr = document.getElementById('tab-create');
  const form = document.getElementById('auth-form');
  const email = document.getElementById('auth-email');
  const pass = document.getElementById('auth-pass');

  let mode = 'signin';
  tabIn.onclick = ()=>{ mode='signin'; tabIn.classList.add('active'); tabCr.classList.remove('active'); };
  tabCr.onclick = ()=>{ mode='create'; tabCr.classList.add('active'); tabIn.classList.remove('active'); };

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    try{
      if (mode === 'signin'){
        await auth.signInWithEmailAndPassword(email.value, pass.value);
      }else{
        await auth.createUserWithEmailAndPassword(email.value, pass.value);
      }
      await ensureProfile(auth.currentUser.uid, { email: email.value });
      toast("You're in.");
      history.back();
    }catch(err){ toast(err.message); }
  });
}

// Make sure a basic user doc + handle exists
async function ensureProfile(uid, extra = {}){
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists){
    const handle = 'user' + Math.floor(Math.random()*9000 + 1000);
    await ref.set({
      handle,
      displayName: 'New Friend',
      bio: '',
      province: 'QC',
      country: 'CA',
      socials: {},
      photoURL: '',
      birthdate: '2000-01-01',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...extra
    }, { merge:true });
    await db.collection('handles').doc(handle).set({ uid });
  }
}

/* ==============================
   ME (profile + display name edit + avatar upload)
============================== */
async function renderMe(){
  const root = document.getElementById('app');
  const tpl = document.getElementById('tpl-profile');
  root.appendChild(tpl.content.cloneNode(true));
  if (!auth.currentUser){ return renderAuth(); }
  const uid = auth.currentUser.uid;

  const uDoc = await db.collection('users').doc(uid).get();
  const pDoc = await db.collection('profiles').doc(uid).get();
  const u = uDoc.data() || {};
  const p = pDoc.data() || { questions: [] };

  const avatarEl = document.getElementById('me-avatar');
  const handleEl = document.getElementById('me-handle');
  const nameEl = document.getElementById('me-name');
  const locEl = document.getElementById('me-location');
  const bioEl = document.getElementById('me-bio');
  const socials = document.getElementById('me-socials');

  avatarEl.src = u.photoURL || '/img/placeholder-avatar.png';
  handleEl.textContent = '@' + u.handle;
  nameEl.textContent = u.displayName || u.handle;
  locEl.textContent = `${u.province || ''} ${u.country ? '🇨🇦' : ''}`;
  bioEl.textContent = u.bio || '';
  socials.innerHTML = '';
  Object.entries(u.socials || {}).forEach(([k,v])=> v && socials.appendChild(el('a',{href:v,target:'_blank'},k)));

  // Inline editor for display name
  const nameRow = el('div', { class:'card', style:'margin-top:10px' }, [
    el('label', { class:'muted small' }, 'Display Name'),
    el('div', { style:'display:flex; gap:8px; margin-top:6px' }, [
      el('input', { id:'dn-input', value: (u.displayName || ''), placeholder:'Your name', style:'flex:1; padding:10px 12px; border-radius:10px; border:1px solid rgba(0,0,0,.1)' }),
      el('button', { id:'dn-save', class:'btn' }, 'Save')
    ])
  ]);
  root.querySelector('.container').appendChild(nameRow);
  document.getElementById('dn-save').onclick = async ()=>{
    const v = (document.getElementById('dn-input').value || '').trim().slice(0,50);
    await db.collection('users').doc(uid).set({ displayName: v || u.handle }, { merge:true });
    nameEl.textContent = v || u.handle;
    toast('Display name updated.');
  };

  // Change photo
  const photoRow = el('div', { class:'card', style:'margin-top:10px' }, [
    el('div', { class:'muted small' }, 'Profile Photo'),
    el('div', { style:'display:flex; gap:8px; margin-top:6px; align-items:center' }, [
      el('button', { id:'photo-btn', class:'btn' }, 'Change photo'),
      el('input', { id:'photo-file', type:'file', accept:'image/*', style:'display:none' })
    ])
  ]);
  root.querySelector('.container').appendChild(photoRow);

  document.getElementById('photo-btn').onclick = ()=> document.getElementById('photo-file').click();
  document.getElementById('photo-file').addEventListener('change', async (e)=>{
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return toast('Max 2MB image.');
    const ref = storage.ref(`avatars/${uid}/profile.jpg`);
    await ref.put(f, { contentType: f.type || 'image/jpeg' });
    const url = await ref.getDownloadURL();
    await db.collection('users').doc(uid).set({ photoURL: url }, { merge:true });
    avatarEl.src = url;
    toast('Photo updated.');
  });

  // Share links
  const base = location.origin;
  const handleLink = `${base}/@${u.handle}`;
  const uidLink    = `${base}/p/${uid}`;
  document.getElementById('share-handle').value = handleLink;
  document.getElementById('share-uid').value    = uidLink;
  document.getElementById('copy-handle').onclick = ()=> { navigator.clipboard.writeText(handleLink); toast('Copied handle link'); };
  document.getElementById('copy-uid').onclick    = ()=> { navigator.clipboard.writeText(uidLink); toast('Copied backup link'); };

  // My questions preview
  const list = document.getElementById('my-questions');
  list.innerHTML = '';
  (p.questions || []).forEach((q,i)=>{
    list.appendChild(el('div', { class:'bubble card' }, [
      el('div', { class:'q' }, q),
      el('div', { class:'muted small' }, `Q${i+1}`)
    ]));
  });
}

/* ==============================
   VIEW p1 BY HANDLE/UID (p2 answers)
============================== */
async function renderViewByHandle(handleWithAt){
  const handle = handleWithAt.startsWith('@') ? handleWithAt.slice(1) : handleWithAt;
  const hDoc = await db.collection('handles').doc(handle).get();
  if (!hDoc.exists) return notFound();
  return renderViewByUid(hDoc.data().uid);
}

async function renderViewByUid(uid){
  const root = document.getElementById('app');
  root.innerHTML = '';
  const tpl = document.getElementById('tpl-view-profile');
  root.appendChild(tpl.content.cloneNode(true));

  const uDoc = await db.collection('users').doc(uid).get();
  const pDoc = await db.collection('profiles').doc(uid).get();
  if (!uDoc.exists) return notFound();
  const u = uDoc.data() || {};
  const p = pDoc.data() || { questions: [] };

  // Header
  document.getElementById('vp-avatar').src = u.photoURL || '/img/placeholder-avatar.png';
  document.getElementById('vp-handle').textContent = '@' + (u.handle || 'unknown');
  document.getElementById('vp-name').textContent = u.displayName || u.handle || 'Friend';
  document.getElementById('vp-location').textContent = `${u.province || ''} ${u.country ? '🇨🇦' : ''}`;
  const socials = document.getElementById('vp-socials');
  socials.innerHTML = '';
  Object.entries(u.socials || {}).forEach(([k,v])=> v && socials.appendChild(el('a',{href:v,target:'_blank'},k)));

  // Questionnaire form
  const form = document.getElementById('answer-form');

  // Restore local cached answers
  const restored = loadLocal(uid);
  (p.questions || []).forEach((q, idx)=>{
    const ta = el('textarea', { placeholder:'Your answer...' }, '');
    ta.value = restored[idx] || '';
    ta.addEventListener('input', ()=> saveLocal(uid, collectAnswers(form)));
    form.appendChild(el('div', { class:'bubble card' }, [
      el('div', { class:'q' }, q),
      ta
    ]));
  });

  // Submit
  const submitBtn = document.getElementById('submit-answers');
  submitBtn.onclick = async ()=>{
    const answers = collectAnswers(form);
    if (answers.length === 0) return toast('Write something first.');

    // Save locally before any redirect
    saveLocal(uid, answers);

    if (!auth.currentUser){
      localStorage.setItem(LS.pendingTarget, uid);
      localStorage.setItem(LS.pendingRedirect, location.pathname + location.search + location.hash);
      location.hash = '#/auth';
      return;
    }

    try{
      await submitAnswersFlow(uid, answers);   // throws if duplicate or forbidden
      clearLocal(uid);
      toast('Submitted!');
      renderViewByUid(uid);
    }catch(err){
      toast(err?.message || 'Submit failed');
    }
  };
}

function collectAnswers(form){
  const arr = [];
  form.querySelectorAll('textarea').forEach(t=> arr.push((t.value||'').slice(0,2000)));
  return arr;
}
function loadLocal(uid){
  try{ return JSON.parse(localStorage.getItem(LS.pendingAnswers(uid)) || '[]'); }catch{ return []; }
}
function saveLocal(uid, answers){
  localStorage.setItem(LS.pendingAnswers(uid), JSON.stringify(answers));
}
function clearLocal(uid){
  localStorage.removeItem(LS.pendingAnswers(uid));
}

// Submit with rule-friendly fallback
async function submitAnswersFlow(targetUid, answers){
  if (!auth.currentUser) throw new Error('Not signed in');
  const me = auth.currentUser.uid;

  // Duplicate guard using responder-owned collection (your rules allow owner write)
  const sentRef = db.collection('users').doc(me).collection('sentRequests').doc(targetUid);
  const sentSnap = await sentRef.get();
  if (sentSnap.exists) throw new Error("You've already sent one.");

  // First try: full payload including responder snapshot
  const fullPayload = {
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    answers,
    responder: await makeResponderSnapshot(me),
    status: 'pending'
  };

  try {
    await db.collection('users').doc(targetUid).collection('applications').doc(me).set(fullPayload);
  } catch (e) {
    // If rules block extra fields, retry with minimal payload your rules accept
    if (String(e && e.code).includes('permission') || String(e && e.message).toLowerCase().includes('permission')) {
      const minimalPayload = {
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        answers,
        status: 'pending'
      };
      await db.collection('users').doc(targetUid).collection('applications').doc(me).set(minimalPayload);
    } else {
      throw e;
    }
  }

  // Track on responder side
  await sentRef.set({
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    status: 'pending'
  });
}

function notFound(){
  const root = document.getElementById('app');
  root.innerHTML = "<section class='container narrow'><div class='card'>User not found.</div></section>";
}

async function makeResponderSnapshot(uid){
  const doc = await db.collection('users').doc(uid).get();
  const u = doc.data() || {};
  return {
    uid,
    handle: u.handle,
    displayName: u.displayName,
    photoURL: u.photoURL || '',
    socials: u.socials || {},
    province: u.province || '',
    country: u.country || '',
    age: ageFromBirthdate(u.birthdate||'2000-01-01'),
    capturedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

/* ==============================
   INBOX + DETAIL
============================== */
async function renderInbox(){
  const root = document.getElementById('app');
  const tpl = document.getElementById('tpl-inbox');
  root.appendChild(tpl.content.cloneNode(true));
  if (!auth.currentUser){ return renderAuth(); }
  const uid = auth.currentUser.uid;

  const list = document.getElementById('inbox-list');
  list.innerHTML = '';

  const q = await db.collection('users').doc(uid).collection('applications')
    .orderBy('createdAt','desc').limit(50).get();
  if (q.empty){ list.innerHTML = "<div class='card'>Nothing here yet.</div>"; return; }

  for (const docSnap of q.docs) {
    const data = docSnap.data();
    let r = data.responder;

    // Fallback: if responder snapshot missing, fetch public user doc
    if (!r) {
      try {
        const userDoc = await db.collection('users').doc(docSnap.id).get();
        const u = userDoc.data() || {};
        r = { displayName: u.displayName || u.handle || 'Someone', handle: u.handle || 'anon', photoURL: u.photoURL || '' };
      } catch (_) { r = { displayName: 'Someone', handle: 'anon', photoURL: '' }; }
    }

    const row = el('div', { class:'item', onclick: ()=> renderInboxDetail(docSnap.id) }, [
      el('div', { class:'row' }, [
        el('img', { class:'avatar-sm', src: (r.photoURL || '/img/placeholder-avatar.png') }),
        el('div', {}, [
          el('div', { class:'strong' }, r.displayName || r.handle || 'Someone'),
          el('div', { class:'muted small' }, '@' + (r.handle || 'anon'))
        ]),
        el('div', { style:'margin-left:auto; font-weight:600' }, data.status || 'pending')
      ])
    ]);
    list.appendChild(row);
  }
}

async function renderInboxDetail(responderUid){
  const root = document.getElementById('app');
  root.innerHTML = '';
  const tpl = document.getElementById('tpl-inbox-detail');
  root.appendChild(tpl.content.cloneNode(true));
  const me = auth.currentUser.uid;

  document.getElementById('back-inbox').onclick = ()=> location.hash = '#/inbox';

  const appDoc = await db.collection('users').doc(me).collection('applications').doc(responderUid).get();
  if (!appDoc.exists){ return notFound(); }
  const data = appDoc.data();

  let titleName = data?.responder?.displayName || data?.responder?.handle;
  if (!titleName) {
    try {
      const userDoc = await db.collection('users').doc(responderUid).get();
      const u = userDoc.data() || {};
      titleName = u.displayName || u.handle || 'Someone';
    } catch (_) {
      titleName = 'Someone';
    }
  }
  document.getElementById('id-title').textContent = `Application from ${titleName}`;

  const answersWrap = document.getElementById('id-answers');
  answersWrap.innerHTML = '';
  (data.answers || []).forEach((ans, i)=>{
    answersWrap.appendChild(el('div',{class:'bubble card'},[
      el('div',{class:'muted small'}, `Answer ${i+1}`),
      el('div',{}, ans || '')
    ]));
  });

  document.getElementById('id-accept').onclick = ()=> accept(responderUid);
  document.getElementById('id-reject').onclick = ()=> reject(responderUid);

  async function accept(other){
    const meDoc = await db.collection('users').doc(me).get();
    const otherDoc = await db.collection('users').doc(other).get();
    const myAge = ageFromBirthdate(meDoc.data().birthdate);
    const theirAge = ageFromBirthdate(otherDoc.data().birthdate);
    if (!allowedPairing(myAge, theirAge)) return toast('Age rules do not allow this connection.');

    const pair = [me, other].sort().join('_');
    await db.collection('friendships').doc(pair).set({
      users: [me, other],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      canMessage: true
    }, { merge:true });
    await db.collection('users').doc(me).collection('applications').doc(other).set({ status:'accepted' }, { merge:true });
    toast('Connected. You can now message each other.');
    location.hash = '#/messages';
  }
  async function reject(other){
    await db.collection('users').doc(me).collection('applications').doc(other).set({ status:'rejected' }, { merge:true });
    toast('Rejected.');
    location.hash = '#/inbox';
  }
}

/* ==============================
   MESSAGES placeholder
============================== */
async function renderMessages(){
  const root = document.getElementById('app');
  root.innerHTML = '<section class="container narrow"><div class="card">Messaging UI coming next. Friendships exist after acceptance.</div></section>';
}
