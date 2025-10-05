import { ageFromBirthdate, allowedPairing, el, observeReveal } from './utils.js';

// Firebase compat init
const app = firebase.initializeApp(window.firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

/* Routing */
const routes = {
  '': renderCreate,
  '#/create': renderCreate,
  '#/inbox': renderInbox,
  '#/me': renderMe,
  '#/auth': renderAuth,
  '#/messages': renderMessages,
};

function deepLink(){
  const p = location.pathname;
  const m1 = p.match(/^\/@([\w.\-]{2,30})$/);
  if (m1) return { kind:'handle', value:m1[1] };
  const m2 = p.match(/^\/p\/([A-Za-z0-9_-]{6,})$/);
  if (m2) return { kind:'uid', value:m2[1] };
  const u = new URLSearchParams(location.search).get('u');
  if (u) return { kind:'handle', value: u.replace(/^@/, '') };
  return null;
}

window.addEventListener('hashchange', mount);
window.addEventListener('popstate', mount);
window.addEventListener('load', mount);

const btnCreate = document.getElementById('btn-create');
const btnInbox  = document.getElementById('btn-inbox');
const btnMe     = document.getElementById('btn-profile');
const btnAuth   = document.getElementById('btn-auth');
const btnMsg    = document.getElementById('btn-messages');
if (btnCreate) btnCreate.onclick = ()=> location.hash = '#/create';
if (btnInbox)  btnInbox.onclick  = ()=> location.hash = '#/inbox';
if (btnMe)     btnMe.onclick     = ()=> location.hash = '#/me';
if (btnAuth)   btnAuth.onclick   = ()=> location.hash = '#/auth';
if (btnMsg)    btnMsg.onclick    = ()=> location.hash = '#/messages';

function toast(m){ alert(m); }

async function mount(){
  const root = document.getElementById('app');
  root.innerHTML = '';
  const link = deepLink();
  if (link){
    if (link.kind === 'handle') return renderViewByHandle('@' + link.value);
    if (link.kind === 'uid')    return renderViewByUid(link.value);
  }
  const fn = routes[location.hash || '#/create'] || renderCreate;
  await fn();
  observeReveal(document);
}

/* Local storage keys */
const LS = {
  draftQuestions: 'lynctree_draft_questions',
  pendingAnswers: targetUid => `pending_answers_${targetUid}`,
  pendingTarget: 'pending_target_uid',
  pendingRedirect: 'pending_redirect_after_auth'
};

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
      else renderViewByUid(target);
    }
  }
});

/* CREATE */
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
    return el('div', { class:'bubble card reveal' }, [
      el('div', { class:'bubble-toolbar' }, [del]),
      el('label', {}, 'Question ' + (index+1)),
      el('textarea', { placeholder:'Type your playful prompt (max ~120 chars)' }, text)
    ]);
  }
}

/* AUTH */
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
      toast("You're signed in 🫡");
      history.back();
    }catch(err){ toast(err.message); }
  });
}

async function ensureProfile(uid, extra = {}){
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists){
    const handle = 'user' + Math.floor(Math.random()*9000 + 1000);
    await ref.set({
      handle,
      displayName: 'New Friend',
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

/* ME */
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
  const socials = document.getElementById('me-socials');

  avatarEl.src = u.photoURL || 'img/placeholder-avatar.png';
  handleEl.textContent = '@' + u.handle;
  nameEl.textContent = u.displayName || u.handle;
  locEl.textContent = `${u.province || ''} ${u.country ? '🇨🇦' : ''}`;
  socials.innerHTML = '';
  Object.entries(u.socials || {}).forEach(([k,v])=> v && socials.appendChild(el('a',{href:v,target:'_blank'},k)));

  const base = location.origin;
  const handleLink = `${base}/@${u.handle}`;
  const uidLink    = `${base}/p/${uid}`;
  document.getElementById('share-handle').value = handleLink;
  document.getElementById('share-uid').value    = uidLink;
  document.getElementById('copy-handle').onclick = ()=> { navigator.clipboard.writeText(handleLink); toast('Copied handle link'); };
  document.getElementById('copy-uid').onclick    = ()=> { navigator.clipboard.writeText(uidLink); toast('Copied backup link'); };

  observeReveal(document);
}

/* VIEW by handle/uid */
async function renderViewByHandle(handleWithAt){
  const handle = handleWithAt.replace(/^@/, '');
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

  document.getElementById('vp-avatar').src = u.photoURL || 'img/placeholder-avatar.png';
  document.getElementById('vp-name').textContent = u.displayName || u.handle || 'Friend';
  document.getElementById('vp-handle').textContent = '@' + (u.handle || 'unknown');
  document.getElementById('vp-location').textContent = `${u.province || ''} ${u.country ? '🇨🇦' : ''}`;
  const socials = document.getElementById('vp-socials');
  socials.innerHTML = '';
  Object.entries(u.socials || {}).forEach(([k,v])=> v && socials.appendChild(el('a',{href:v,target:'_blank'},k)));

  const form = document.getElementById('answer-form');
  const restored = loadLocal(uid);
  (p.questions || []).forEach((q, idx)=>{
    const ta = el('textarea', { placeholder:'Your answer...' }, '');
    ta.value = restored[idx] || '';
    ta.addEventListener('input', ()=> saveLocal(uid, collectAnswers(form)));
    form.appendChild(el('div', { class:'bubble card reveal' }, [
      el('div', { class:'q' }, q),
      ta
    ]));
  });

  const submitBtn = document.getElementById('submit-answers');
  submitBtn.onclick = async ()=>{
    const answers = collectAnswers(form);
    if (answers.length === 0) return toast('Write something first.');
    saveLocal(uid, answers);
    if (!auth.currentUser){
      localStorage.setItem(LS.pendingTarget, uid);
      localStorage.setItem(LS.pendingRedirect, location.pathname + location.search + location.hash);
      location.hash = '#/auth';
      return;
    }
    try{
      await submitAnswersFlow(uid, answers);
      clearLocal(uid);
      toast('Submitted!');
      renderViewByUid(uid); // stay on p1 page
    }catch(err){ toast(err?.message || 'Submit failed'); }
  };

  observeReveal(document);
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

async function submitAnswersFlow(targetUid, answers){
  if (!auth.currentUser) throw new Error('Not signed in');
  const me = auth.currentUser.uid;

  const sentRef = db.collection('users').doc(me).collection('sentRequests').doc(targetUid);
  const sentSnap = await sentRef.get();
  if (sentSnap.exists) throw new Error("You've already sent one.");

  const payload = {
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    answers,
    status: 'pending'
  };

  await db.collection('users').doc(targetUid).collection('applications').doc(me).set(payload);
  await sentRef.set({ createdAt: firebase.firestore.FieldValue.serverTimestamp(), status:'pending' });
}

function notFound(){
  const root = document.getElementById('app');
  root.innerHTML = "<section class='container narrow'><div class='card'>User not found.</div></section>";
}

/* INBOX */
async function renderInbox(){
  const root = document.getElementById('app');
  const tpl = document.getElementById('tpl-inbox');
  root.appendChild(tpl.content.cloneNode(true));
  if (!auth.currentUser){ return renderAuth(); }
  const uid = auth.currentUser.uid;

  const list = document.getElementById('inbox-list');
  list.innerHTML = '';

  const q = await db.collection('users').doc(uid).collection('applications').orderBy('createdAt','desc').limit(50).get();
  if (q.empty){ list.innerHTML = "<div class='card'>Nothing here yet.</div>"; return; }

  q.forEach(docSnap=>{
    const data = docSnap.data();
    const row = el('div', { class:'item reveal', onclick: ()=> renderInboxDetail(docSnap.id) }, [
      el('div', { class:'row' }, [
        el('img', { class:'avatar-sm', src: (data?.responder?.photoURL) || 'img/placeholder-avatar.png' }),
        el('div', {}, [
          el('div', { class:'strong' }, (data?.responder?.displayName) || (data?.responder?.handle) || 'Someone'),
          el('div', { class:'muted small' }, '@' + ((data?.responder?.handle) || 'anon'))
        ]),
        el('div', { style:'margin-left:auto; font-weight:600' }, data.status || 'pending')
      ])
    ]);
    list.appendChild(row);
  });

  observeReveal(document);
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
  document.getElementById('id-title').textContent = `Application from ${data?.responder?.displayName || data?.responder?.handle || 'Someone'}`;

  const answersWrap = document.getElementById('id-answers');
  answersWrap.innerHTML = '';
  (data.answers || []).forEach((ans, i)=>{
    answersWrap.appendChild(el('div',{class:'bubble card reveal'},[
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

  observeReveal(document);
}

/* MESSAGES skeleton */
async function renderMessages(){
  const root = document.getElementById('app');
  const tpl = document.getElementById('tpl-messages');
  root.appendChild(tpl.content.cloneNode(true));
  if (!auth.currentUser){ return renderAuth(); }
  const uid = auth.currentUser.uid;

  const threadList = document.getElementById('thread-list');
  const threadWrap = document.getElementById('thread');
  const backBtn = document.getElementById('back-threads');
  const body = document.getElementById('thread-body');
  const title = document.getElementById('thread-title');
  const form = document.getElementById('thread-form');
  const input = document.getElementById('msg-input');

  backBtn.onclick = ()=>{ threadWrap.classList.add('hidden'); threadList.classList.remove('hidden'); };

  const q = await db.collection('friendships').where('users','array-contains', uid).limit(50).get();
  if (q.empty){ threadList.innerHTML = '<div class="card">No conversations yet.</div>'; return; }

  q.forEach(d=>{
    const pairId = d.id;
    const other = d.data().users.find(x=> x !== uid) || 'unknown';
    const item = el('div',{class:'item', onclick: ()=> openThread(pairId)},[ el('div',{}, `Chat with ${other.slice(0,6)}…`) ]);
    threadList.appendChild(item);
  });

  async function openThread(pairId){
    threadList.classList.add('hidden');
    threadWrap.classList.remove('hidden');
    title.textContent = 'Chat';

    const msgs = await db.collection('friendships').doc(pairId).collection('messages').orderBy('createdAt').limit(50).get();
    body.innerHTML = '';
    msgs.forEach(m=>{
      const data = m.data();
      body.appendChild(el('div',{class:'msg ' + (data.uid===uid?'me':'them')}, data.text || ''));
    });

    form.onsubmit = async (e)=>{
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await db.collection('friendships').doc(pairId).collection('messages').add({
        uid, text, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      body.appendChild(el('div',{class:'msg me'}, text));
      body.scrollTop = body.scrollHeight;
    };
  }
}
