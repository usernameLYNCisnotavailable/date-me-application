// utils.js — helpers
export function el(tag, attrs = {}, children = []){
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k,v])=>{
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c=>{
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else if (c instanceof Node) node.appendChild(c);
  });
  return node;
}

export function ageFromBirthdate(iso){
  const d = new Date(iso);
  if (isNaN(d)) return 0;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return Math.max(0, age);
}

export function allowedPairing(a,b){
  const min = Math.min(a,b), max = Math.max(a,b);
  if (min === 14) return max <= 15;
  if (min === 15) return max <= 16;
  if (min === 16) return max <= 17;
  if (min === 17) return max <= 18;
  return min >= 17; // 18+ with 17 bridge
}

export function observeReveal(root=document){
  const items = [...root.querySelectorAll('.reveal, .bubble, .card')];
  const obs = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if (e.isIntersecting){
        e.target.classList.add('in');
        obs.unobserve(e.target);
      }
    });
  }, { threshold: 0.1 });
  items.forEach(el=> obs.observe(el));
}
