// utils.js — helpers

export function ageFromBirthdate(iso){
  const d = new Date(iso);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

export function allowedPairing(a, b){
  const band = (x)=>{
    if (x <= 14) return [14,15];
    if (x === 15) return [15,16];
    if (x === 16) return [16,17];
    if (x === 17) return [17,18];
    return [17, 200]; // 18+
  };
  const [loA, hiA] = band(a);
  const [loB, hiB] = band(b);
  return b >= loA && b <= hiA && a >= loB && a <= hiB;
}

export function el(tag, attrs = {}, children = []){
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k,v]) => {
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function"){ node.addEventListener(k.slice(2), v); }
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  });
  return node;
}

export function countryFlag(code){
  if (!code) return "";
  if (code.toUpperCase() === "CA") return "🇨🇦";
  return "";
}

export function uid(){ return Math.random().toString(36).slice(2); }
